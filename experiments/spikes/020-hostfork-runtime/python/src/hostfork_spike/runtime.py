"""Library-first experiment in owned, host-derived Linux environments.

This is a research implementation, not a security boundary. Mount changes are
selective: every other host path remains visible and writable as on the host.
"""

import asyncio
import dataclasses
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Literal

from .linux import alive, remove_overlay_work, signal_verified


@dataclasses.dataclass(frozen=True)
class Mount:
    """One mount substitution at an existing absolute host path.

    Read-only applies to the bind mount itself, not recursively to submounts.
    Fresh uses a private, persistent empty directory in the artifact directory.
    """

    kind: Literal["overlay", "read_only", "bind", "fresh"]
    target: str
    source: str | None = None


@dataclasses.dataclass(frozen=True)
class Export:
    """Copy a final path from the mounted view into a relative export path."""

    source: str
    destination: str


@dataclasses.dataclass(frozen=True)
class EnvironmentSpec:
    """Filesystem substitutions and environment lifetime policy.

    Deadline starts when the supervisor starts, includes setup and is never
    extended by launching another process. Termination/export grace follows it.
    """

    mounts: list[Mount] = dataclasses.field(default_factory=list)
    deadline_seconds: float | None = None
    retain_on_owner_exit: bool = False
    exports: list[Export] = dataclasses.field(default_factory=list)
    termination_grace_seconds: float = 0.25
    cleanup_timeout_seconds: float = 5.0


def _load(path: Path) -> dict:
    return json.loads((path / "state.json").read_text())


async def _request(path: Path, method: str, **params: object) -> dict:
    config = json.loads((path / "config.json").read_text())
    reader, writer = await asyncio.open_unix_connection("\0" + config["socket_name"])
    try:
        message = {"environment_id": config["environment_id"], "method": method, **params}
        writer.write((json.dumps(message) + "\n").encode())
        await writer.drain()

        async def read_response() -> dict:
            data = bytearray()
            while b"\n" not in data:
                chunk = await reader.read(65536)
                if not chunk:
                    raise ConnectionError("Supervisor closed its control socket")
                data.extend(chunk)
            return json.loads(data)

        response = await asyncio.wait_for(read_response(), 15)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]
    finally:
        writer.close()
        await writer.wait_closed()


async def status_at(path: str | Path) -> dict:
    """Read live status, falling back to the durable journal after supervisor loss."""
    path = Path(path).absolute()
    try:
        return await _request(path, "status")
    except (ConnectionError, FileNotFoundError):
        state = _load(path)
        state["supervisor_alive"] = alive(state.get("supervisor_identity"))
        state["namespace_init_alive"] = alive(state.get("namespace_init_identity"))
        if state["state"] not in ("closed", "failed"):
            state["state"] = "orphaned" if state["namespace_init_alive"] else "lost"
            state["reason"] = "supervisor_lost"
        if (path / "init-final.json").exists():
            state["init_final"] = json.loads((path / "init-final.json").read_text())
        if (path / "recovery.json").exists():
            state["recovery"] = json.loads((path / "recovery.json").read_text())
        return state


async def stop_at(path: str | Path, reason: str = "external_stop", timeout: float = 15) -> dict:
    """Stop via the supervisor; recover a lost supervisor using verified pidfds.

    Recovery never guesses a process group from an expired numeric PID. Killing
    the namespace init makes the kernel kill every process in that namespace.
    """
    path = Path(path).absolute()
    previous = _load(path)
    if previous["state"] in ("closed", "failed") and previous["cleanup"]["namespace_released"]:
        return previous
    try:
        await _request(path, "stop", reason=reason)
    except (ConnectionError, FileNotFoundError):
        state = _load(path)
        if state["state"] in ("closed", "failed") and state["cleanup"]["namespace_released"]:
            return state
        if alive(state.get("supervisor_identity")):
            raise RuntimeError("Supervisor still exists but its control socket is unavailable; inspect artifacts")
        expected = state.get("namespace_init_identity")
        killed = signal_verified(expected) if expected else False
        recovery = {"reason": reason, "init_killed": killed, "time": time.time(), "identity": expected}
        if expected is None and state.get("precursor_identity"):
            recovery["precursor_killed"] = signal_verified(state["precursor_identity"])
        (path / "recovery.json").write_text(json.dumps(recovery, indent=2) + "\n")
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        state = await status_at(path)
        if (state["state"] in ("closed", "failed") and state["cleanup"]["namespace_released"]) or (
            not alive(state.get("supervisor_identity")) and not alive(state.get("namespace_init_identity"))
        ):
            if not alive(state.get("namespace_init_identity")):
                config = json.loads((path / "config.json").read_text())
                work_cleanup = remove_overlay_work(path, config["spec"]["mounts"])
                if work_cleanup:
                    state.setdefault("recovery", {})["overlay_work"] = work_cleanup
                    (path / "recovery.json").write_text(json.dumps(state["recovery"], indent=2) + "\n")
            return state
        await asyncio.sleep(0.02)
    raise TimeoutError(f"Environment cleanup timed out: {path}")


class Process:
    """A command running inside an environment; output is retained in files."""

    def __init__(self, environment: "Environment", process_id: str):
        self.environment = environment
        self.id = process_id

    async def wait(self, timeout: float | None = None) -> dict:
        async def waiting() -> dict:
            while True:
                state = await self.environment.status()
                process = state.get("processes", {}).get(self.id)
                if process and process.get("returncode") is not None:
                    return process
                if state["state"] in ("closed", "failed", "lost", "orphaned"):
                    process = dict(process or {"id": self.id})
                    process.setdefault("returncode", None)
                    process["reason"] = state.get("reason", "environment_lost")
                    process["exit_observed"] = False
                    return process
                await asyncio.sleep(0.01)

        return await asyncio.wait_for(waiting(), timeout)


class Environment:
    """Own a multi-command mount/PID view and an independent deadline supervisor."""

    def __init__(self, path: Path, owner_fd: int, helper: asyncio.subprocess.Process, inherit_stdio: bool):
        self.path = path
        self._owner_fd: int | None = owner_fd
        self._helper = helper
        self._inherit_stdio = inherit_stdio

    @classmethod
    async def create(
        cls,
        spec: EnvironmentSpec | None = None,
        *,
        artifact_root: str | Path,
        inherit_stdio: bool = False,
    ) -> "Environment":
        """Start a fresh helper and return once namespace setup succeeds."""
        spec = spec or EnvironmentSpec()
        if spec.deadline_seconds is not None and spec.deadline_seconds <= 0:
            raise ValueError("deadline_seconds must be positive")
        if spec.retain_on_owner_exit and spec.deadline_seconds is None:
            raise ValueError("This spike requires a deadline when retaining after owner exit")
        if spec.termination_grace_seconds < 0 or spec.cleanup_timeout_seconds <= 0:
            raise ValueError("Invalid cleanup grace or timeout")
        root = Path(artifact_root).resolve()
        root.mkdir(parents=True, exist_ok=True)
        for mount_spec in spec.mounts:
            target = Path(mount_spec.target)
            if not target.is_absolute() or not target.exists() or target.is_symlink() or target == Path("/"):
                raise ValueError(f"Mount target must be an existing absolute non-symlink path other than /: {target}")
            if root.is_relative_to(target.resolve()):
                raise ValueError(f"Mount would hide runtime artifacts: {target}")
            if mount_spec.kind not in ("overlay", "read_only", "bind", "fresh"):
                raise ValueError(f"Unknown mount kind: {mount_spec.kind}")
            if mount_spec.source and not Path(mount_spec.source).is_absolute():
                raise ValueError("Mount sources must be absolute")
            if mount_spec.kind == "bind" and mount_spec.source is None:
                raise ValueError("Bind mounts require a source")
            if mount_spec.kind in ("fresh", "overlay") and not target.is_dir():
                raise ValueError("Fresh and overlay mounts require directories")
        for export in spec.exports:
            destination = Path(export.destination)
            if not Path(export.source).is_absolute() or destination.is_absolute() or ".." in destination.parts:
                raise ValueError("Export source must be absolute and destination must stay inside exports")
        path = Path(tempfile.mkdtemp(prefix="env-", dir=root))
        environment_id = uuid.uuid4().hex
        config = {
            "environment_id": environment_id,
            "socket_name": f"hostfork-spike-{environment_id}",
            "artifact_path": str(path),
            "spec": dataclasses.asdict(spec),
            "inherit_stdio": inherit_stdio,
            "initial_cwd": os.getcwd(),
        }
        (path / "config.json").write_text(json.dumps(config, indent=2) + "\n")
        read_fd, write_fd = os.pipe()
        os.set_inheritable(read_fd, True)
        helper_path = Path(__file__).with_name("helper.py")
        try:
            helper = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                str(helper_path),
                "supervisor",
                str(path),
                str(read_fd),
                pass_fds=(read_fd,),
                stdin=None if inherit_stdio else asyncio.subprocess.DEVNULL,
                stdout=None if inherit_stdio else asyncio.subprocess.DEVNULL,
                stderr=None if inherit_stdio else asyncio.subprocess.DEVNULL,
            )
        except BaseException:
            os.close(write_fd)
            raise
        finally:
            os.close(read_fd)
        environment = cls(path, write_fd, helper, inherit_stdio)
        try:
            until = time.monotonic() + 15
            while time.monotonic() < until:
                if (path / "state.json").exists():
                    state = _load(path)
                    if state["state"] == "running":
                        return environment
                    if state["state"] in ("failed", "closed"):
                        failure = state.get("error", state.get("reason"))
                        raise RuntimeError(f"Environment setup failed: {failure}; {path}")
                if helper.returncode is not None:
                    raise RuntimeError(f"Supervisor exited during setup; inspect {path}")
                await asyncio.sleep(0.01)
            raise TimeoutError(f"Namespace setup timed out: {path}")
        except BaseException:
            environment.detach()
            if (path / "state.json").exists():
                await stop_at(path, reason="startup_cancelled")
            try:
                await asyncio.wait_for(helper.wait(), 7)
            except TimeoutError:
                # Verified identity is journaled before namespace construction.
                if (path / "state.json").exists():
                    await stop_at(path, reason="startup_cancelled")
            raise

    async def spawn(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        stdio: Literal["logs", "inherit"] = "logs",
    ) -> Process:
        """Launch a command; environment overrides merge with inherited variables."""
        if not argv or stdio not in ("logs", "inherit"):
            raise ValueError("A command and valid stdio mode are required")
        if stdio == "inherit" and not self._inherit_stdio:
            raise ValueError("Inherited command stdio requires Environment.create(inherit_stdio=True)")
        result = await _request(self.path, "spawn", argv=argv, cwd=cwd, env=env, stdio=stdio)
        return Process(self, result["id"])

    async def run(self, argv: list[str], **kwargs: object) -> dict:
        """Launch and wait for a command without closing its environment."""
        return await (await self.spawn(argv, **kwargs)).wait()

    async def status(self) -> dict:
        return await status_at(self.path)

    async def close(self, reason: str = "requested") -> dict:
        """Stop workloads, export configured paths, then release namespace mounts."""

        async def finish() -> dict:
            result = await stop_at(self.path, reason=reason)
            await asyncio.wait_for(self._helper.wait(), 10)
            return result

        cleanup = asyncio.create_task(finish())
        try:
            return await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            # A cancelled waiter must not cancel the already requested cleanup,
            # including for environments configured to survive owner loss.
            await asyncio.shield(cleanup)
            raise
        finally:
            self.detach()

    def detach(self) -> None:
        """Drop ownership; policy selects immediate cleanup or deadline retention."""
        if self._owner_fd is not None:
            os.close(self._owner_fd)
            self._owner_fd = None

    async def __aenter__(self) -> "Environment":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    def __del__(self) -> None:
        self.detach()
