"""Python-owned subprocesses adopted by transient user systemd scopes.

The returned process is an actual asyncio.subprocess.Process. The gate prevents
workload descendants before adoption; children created afterward inherit the
cgroup without using this module. A persistent D-Bus connection passes a pidfd
and holds a reference to the unit until final metadata has been read.
This is a research adapter, not a production API or security boundary.
"""

import asyncio
import ctypes
import json
import os
import sys
import time
import uuid
from pathlib import Path

from dbus_next import Message, MessageType, Variant
from dbus_next.aio import MessageBus
from hostfork_spike.linux import alive, identity, signal_verified

HERE = Path(__file__).resolve().parent
PROPERTIES = (
    "LoadState",
    "ActiveState",
    "SubState",
    "Result",
    "ControlGroup",
    "RuntimeMaxUSec",
    "TimeoutStopUSec",
    "CPUUsageNSec",
    "MemoryPeak",
    "MemoryCurrent",
    "TasksCurrent",
)


def save(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


async def command(*argv: str, check: bool = True) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 8)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    if check and process.returncode:
        raise RuntimeError(f"{argv[0]} exited {process.returncode}: {stderr.decode().strip()}")
    return process.returncode, stdout.decode().strip(), stderr.decode().strip()


async def inspect(unit: str) -> dict[str, str]:
    _, output, _ = await command("systemctl", "--user", "show", unit, *(f"--property={p}" for p in PROPERTIES))
    state = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    # systemctl prints defaults even for an already collected transient unit.
    return state if state.get("LoadState") != "not-found" else {"LoadState": "not-found"}


async def stop(unit: str) -> None:
    await command("systemctl", "--user", "stop", unit, check=False)


async def forget(unit: str) -> None:
    await stop(unit)
    await command("systemctl", "--user", "reset-failed", unit, check=False)


def membership(pid: int) -> str:
    return next(line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if line.startswith("0::"))


def members(cgroup: str) -> list[dict]:
    root = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    result = []
    for path in [root / "cgroup.procs", *root.glob("**/cgroup.procs")]:
        try:
            for pid in path.read_text().split():
                try:
                    item = identity(int(pid))
                    if item not in result:
                        result.append(item)
                except (FileNotFoundError, ProcessLookupError):
                    pass
        except FileNotFoundError:
            pass
    return result


def open_pidfd(expected: dict) -> int:
    """Pin and verify an identity, including on standalone Python builds."""
    if hasattr(os, "pidfd_open"):
        descriptor = os.pidfd_open(expected["pid"])
    else:
        libc = ctypes.CDLL(None, use_errno=True)
        descriptor = libc.pidfd_open(ctypes.c_int(expected["pid"]), ctypes.c_uint(0))
        if descriptor < 0:
            raise OSError(ctypes.get_errno(), "pidfd_open")
    if not alive(expected):
        os.close(descriptor)
        raise ProcessLookupError("Original child exited before registration")
    return descriptor


class ScopedProcess:
    """A normal Python subprocess plus its independent systemd ownership record."""

    def __init__(self, root: Path, process: asyncio.subprocess.Process, gate_fd: int | None, record: dict):
        self.root, self.process, self.gate_fd, self.record = root, process, gate_fd, record
        self.bus: MessageBus | None = None
        self.referenced = False

    async def manager(self, member: str, signature: str, body: list, unix_fds: list[int] | None = None) -> list:
        if self.bus is None:
            address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{os.getuid()}/bus")
            self.bus = await asyncio.wait_for(MessageBus(bus_address=address, negotiate_unix_fd=True).connect(), 5)
        reply = await asyncio.wait_for(
            self.bus.call(
                Message(
                    destination="org.freedesktop.systemd1",
                    path="/org/freedesktop/systemd1",
                    interface="org.freedesktop.systemd1.Manager",
                    member=member,
                    signature=signature,
                    body=body,
                    unix_fds=unix_fds or [],
                )
            ),
            5,
        )
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError(f"{reply.error_name}: {reply.body}")
        return reply.body

    @classmethod
    async def prepare(
        cls,
        argv: list[str],
        *,
        artifact_root: Path,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        stdin=None,
        stdout=None,
        stderr=None,
    ) -> "ScopedProcess":
        """Spawn only a waiting gate; caller must adopt before release."""
        root = artifact_root.resolve()
        root.mkdir(parents=True, exist_ok=False)
        unit = f"hostfork-scope-{uuid.uuid4().hex}.scope"
        record = {
            "unit": unit,
            "owner": identity(os.getpid()),
            "argv": argv,
            "cwd": str((cwd or Path.cwd()).resolve()),
            "stage": "preparing",
            "created_at": time.time(),
        }
        save(root / "record.json", record)
        read_fd, write_fd = os.pipe()
        child_env = os.environ.copy()
        child_env.update(env or {})
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                str(HERE / "gate.py"),
                str(read_fd),
                record["cwd"],
                str(root / "released.txt"),
                *argv,
                env=child_env,
                pass_fds=(read_fd,),
                stdin=stdin,
                stdout=stdout,
                stderr=stderr,
            )
        except BaseException:
            os.close(write_fd)
            raise
        finally:
            os.close(read_fd)
        try:
            record.update(stage="gated", launcher=identity(process.pid), original_cgroup=membership(process.pid))
            save(root / "record.json", record)
        except BaseException:
            # Closing the sole writer aborts the controlled gate on EOF even if
            # metadata persistence or /proc inspection failed before adoption.
            os.close(write_fd)
            await asyncio.wait_for(process.wait(), 5)
            raise
        return cls(root, process, write_fd, record)

    async def adopt(self, deadline_seconds: float, *, invalid_property: bool = False) -> None:
        """Create a bounded scope and verify actual cgroup placement before release."""
        if deadline_seconds <= 0:
            raise ValueError("deadline_seconds must be positive")
        self.record.update(stage="registering", requested_deadline_seconds=deadline_seconds)
        save(self.root / "record.json", self.record)
        properties = [
            ["PIDFDs", Variant("ah", [0])],
            ["RuntimeMaxUSec", Variant("t", int(deadline_seconds * 1_000_000))],
            ["TimeoutStopUSec", Variant("t", 200_000)],
            ["KillMode", Variant("s", "control-group")],
            ["AddRef", Variant("b", True)],
            ["CPUAccounting", Variant("b", True)],
            ["MemoryAccounting", Variant("b", True)],
        ]
        if invalid_property:
            properties.append(["HostforkDeliberatelyInvalidProperty", Variant("s", "failure-injection")])
        before = time.monotonic()
        try:
            pidfd = open_pidfd(self.record["launcher"])
            try:
                job = await self.manager(
                    "StartTransientUnit", "ssa(sv)a(sa(sv))", [self.record["unit"], "fail", properties, []], [pidfd]
                )
                self.referenced = True
            finally:
                os.close(pidfd)
            until = time.monotonic() + 5
            while time.monotonic() < until:
                state = await inspect(self.record["unit"])
                cgroup = state.get("ControlGroup")
                if state.get("ActiveState") == "active" and cgroup and membership(self.process.pid) == cgroup:
                    self.record.update(
                        stage="registered",
                        scope=state,
                        cgroup=cgroup,
                        registration_job=job,
                        registration_seconds=time.monotonic() - before,
                    )
                    save(self.root / "record.json", self.record)
                    return
                if self.process.returncode is not None or state.get("ActiveState") == "failed":
                    raise RuntimeError(f"Scope setup failed: {state}")
                await asyncio.sleep(0.01)
            raise TimeoutError("Scope did not become active with the expected process membership")
        except BaseException as error:
            self.record.update(stage="registration_failed", error=f"{type(error).__name__}: {error}")
            save(self.root / "record.json", self.record)
            raise

    def release(self) -> None:
        """Let the gated child exec the target without changing its PID or pipes."""
        if self.record["stage"] != "registered":
            raise RuntimeError("Scope must be registered before releasing workload")
        os.write(self.gate_fd, b"G")
        self.drop_gate()
        self.record.update(stage="released", released_at=time.time())
        save(self.root / "record.json", self.record)

    def drop_gate(self) -> None:
        if self.gate_fd is not None:
            os.close(self.gate_fd)
            self.gate_fd = None

    async def close(self) -> dict:
        """Stop the complete scope, collect leader status, then release unit metadata."""
        self.drop_gate()
        try:
            final = await inspect(self.record["unit"])
            if final.get("ActiveState") in ("active", "activating", "deactivating"):
                await stop(self.record["unit"])
                final = await inspect(self.record["unit"])
            # This fallback handles failures before scope registration. Never
            # assume asyncio leaves an exited child unreaped to prevent PID reuse.
            if self.process.returncode is None:
                signal_verified(self.record["launcher"])
            returncode = await asyncio.wait_for(self.process.wait(), 5)
            self.record.update(stage="closed", returncode=returncode, final_scope=final)
            save(self.root / "record.json", self.record)
        finally:
            try:
                if self.referenced:
                    await self.manager("UnrefUnit", "s", [self.record["unit"]])
                    self.referenced = False
            finally:
                if self.bus is not None:
                    self.bus.disconnect()
                    await self.bus.wait_for_disconnect()
                    self.bus = None
                await forget(self.record["unit"])
        if self.record.get("cgroup"):
            path = Path("/sys/fs/cgroup") / self.record["cgroup"].lstrip("/")
            until = time.monotonic() + 3
            while path.exists() and time.monotonic() < until:
                await asyncio.sleep(0.02)
            if path.exists():
                raise RuntimeError(f"Scope cgroup remained: {path}")
        return self.record


async def launch_scoped(
    argv: list[str],
    *,
    artifact_root: Path,
    deadline_seconds: float,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    stdin=None,
    stdout=None,
    stderr=None,
) -> ScopedProcess:
    """Launch through the gate; return with the independent deadline already armed."""
    scoped = await ScopedProcess.prepare(
        argv,
        artifact_root=artifact_root,
        cwd=cwd,
        env=env,
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
    )
    try:
        await scoped.adopt(deadline_seconds)
        scoped.release()
        return scoped
    except BaseException:
        await scoped.close()
        raise
