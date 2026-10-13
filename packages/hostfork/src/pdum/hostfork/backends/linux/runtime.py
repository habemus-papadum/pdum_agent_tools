"""Reusable Linux mount views with direct Python-owned command processes.

The namespace keeper and admitted commands share one delegated scope. Gated
launches use separate short-lived PIDFD-registered scopes before self-placement;
these scopes are journaled resources too. No namespace is changed in the caller.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ._manager import Manager
from ._syscalls import (
    alive,
    atomic_json,
    cgroup_path,
    group_identity,
    group_matches,
    identity,
    membership,
    pidfd,
    populated,
    signal_identity,
)

_HELPER = Path(__file__).with_name("_helper.py")
_SETUP_SECONDS = 15.0
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


def _validate_id(value: str) -> None:
    if not _ID.fullmatch(value):
        raise ValueError("IDs must contain 1–64 ASCII letters, digits, underscores or hyphens")


def _read(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


async def _finish(awaitable):
    """Finish cleanup even if a caller cancels its surrounding operation again."""
    task = asyncio.ensure_future(awaitable)
    while True:
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():
                return task.result()


async def _spawn(*args, _abort, **kwargs) -> asyncio.subprocess.Process:
    task = asyncio.create_task(asyncio.create_subprocess_exec(*args, **kwargs))
    try:
        return await asyncio.shield(task)
    except BaseException:
        _abort()
        process = await _finish(task)
        await _finish(process.wait())
        raise


async def _ready(connection: socket.socket) -> dict:
    packet = await asyncio.wait_for(asyncio.get_running_loop().sock_recv(connection, 16384), _SETUP_SECONDS)
    if not packet:
        raise RuntimeError("Fresh helper exited before readiness; inspect keeper.log or command stderr")
    result = json.loads(packet)
    if not result.get("ready"):
        raise RuntimeError(f"Fresh helper failed: {result.get('error', result)}")
    return result


async def _hello(connection: socket.socket, process: asyncio.subprocess.Process | subprocess.Popen) -> dict:
    packet = await asyncio.wait_for(asyncio.get_running_loop().sock_recv(connection, 16384), _SETUP_SECONDS)
    if not packet:
        raise RuntimeError("Fresh helper exited before identifying itself")
    expected = json.loads(packet)["identity"]
    if expected["pid"] != process.pid or not alive(expected):
        raise ProcessLookupError("Fresh helper identity no longer matches the child")
    return expected


async def _wait_keeper(process: subprocess.Popen) -> int:
    """Reap our keeper without coupling its lifetime to an asyncio transport.

    A retained keeper must survive event-loop shutdown. Subprocess transports
    kill live children when finalized; a Popen plus nonblocking polling does not.
    Avoid an executor wait as asyncio.run waits for executor threads on exit.
    """
    while (returncode := process.poll()) is None:
        await asyncio.sleep(0.02)
    return returncode


def _socket_pair() -> tuple[socket.socket, socket.socket]:
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    parent.setblocking(False)
    return parent, child


class LinuxCommand:
    """One caller-owned process and its separately observable descendant cgroup.

    Parameters
    ----------
    runtime
        Owning environment runtime.
    process
        The actual asyncio child, which execs the requested executable in place.
    record
        Durable command identity and cgroup metadata.
    """

    def __init__(self, runtime: LinuxRuntime, process: asyncio.subprocess.Process, record: dict):
        self.runtime = runtime
        self.native_process = process
        self.id = record["id"]
        self.identity = record["identity"]
        self.cgroup = record["cgroup"]
        self.record = record

    async def wait_tree(self) -> dict:
        """Wait for this command's cgroup to empty; other commands remain active."""
        path = cgroup_path(self.cgroup)
        while group_matches(path, self.record["cgroup_identity"]) and populated(path):
            await asyncio.sleep(0.02)
        self.record["tree_stopped_at"] = time.time()
        self.record["state"] = "exited"
        self.record["returncode"] = self.native_process.returncode
        self.record["signal"] = -self.native_process.returncode if (self.native_process.returncode or 0) < 0 else None
        atomic_json(self.runtime._command_file(self.id), self.record)
        return dict(self.record)

    async def stop_tree(self) -> dict:
        """Kill this owned cgroup, including reparented or setsid descendants."""
        path = cgroup_path(self.cgroup)
        if group_matches(path, self.record["cgroup_identity"]):
            try:
                (path / "cgroup.kill").write_text("1")
            except FileNotFoundError:
                pass
        self.record["stop_reason"] = "requested"
        return await asyncio.wait_for(self.wait_tree(), 5)


class LinuxRuntime:
    """An owned Linux view and aggregate lifetime, independent of command exit."""

    def __init__(self, state_dir: Path, record: dict):
        self.state_dir = state_dir
        self.record = record
        self.manager = Manager()
        self._owner: socket.socket | None = None
        self._keeper: subprocess.Popen | None = None
        self._commands: dict[str, LinuxCommand] = {}
        self._launches: set[asyncio.Task] = set()
        self._stopping = asyncio.Lock()
        self._keeper_watch: asyncio.Task | None = None

    @classmethod
    async def create(
        cls,
        environment_id: str,
        state_dir: Path,
        mounts: list[dict],
        *,
        max_runtime: float | None = None,
        grace_seconds: float = 0.25,
        memory_bytes: int | None = None,
        cpu_cores: float | None = None,
        owner_exit: str = "stop",
    ) -> LinuxRuntime:
        """Create a scope and reusable namespace, with admission initially gated.

        Parameters
        ----------
        environment_id, state_dir
            Unique journal identity and host-side directory supplied by the coordinator.
        mounts
            Explicit bind, read_only, overlay or disk-backed fresh mount descriptions.
        max_runtime
            Force-stop budget in seconds from scope activation; ``None`` is unbounded.
        grace_seconds
            Grace interval within the runtime budget, before the manager sends SIGKILL.
        memory_bytes, cpu_cores
            Aggregate scope limits. A memory limit disables swap for this scope.
            CPU cores are a CPU-time quota, not CPU affinity.
        owner_exit
            ``stop`` closes the environment on owner-channel loss; ``retain`` leaves it running.
        """
        _validate_id(environment_id)
        if owner_exit not in ("stop", "retain"):
            raise ValueError("owner_exit must be 'stop' or 'retain'")
        if not math.isfinite(grace_seconds) or grace_seconds < 0:
            raise ValueError("grace_seconds must be finite and nonnegative")
        if max_runtime is not None and (not math.isfinite(max_runtime) or max_runtime <= grace_seconds):
            raise ValueError("max_runtime must be finite and greater than grace_seconds")
        if memory_bytes is not None and memory_bytes <= 0:
            raise ValueError("memory_bytes must be positive")
        if cpu_cores is not None and (not math.isfinite(cpu_cores) or cpu_cores <= 0):
            raise ValueError("cpu_cores must be finite and positive")
        root = Path(state_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        if (root / "runtime.json").exists():
            raise FileExistsError(f"Runtime journal already exists: {root}")
        record = {
            "version": 1,
            "id": environment_id,
            "unit": f"pdum-hostfork-{environment_id}.scope",
            "state": "creating",
            "owner": identity(os.getpid()),
            "boot_id": identity(os.getpid())["boot_id"],
            "created_at": time.time(),
            "mounts": mounts,
            "max_runtime": max_runtime,
            "grace_seconds": grace_seconds,
            "owner_exit": owner_exit,
            "memory_bytes": memory_bytes,
            "memory_swap_bytes": 0 if memory_bytes is not None else None,
            "cpu_cores": cpu_cores,
            "setup_timeout_seconds": _SETUP_SECONDS,
            "setup_controller": "CLOCK_MONOTONIC POSIX SIGKILL timer; removed by exec",
            "cleanup_errors": [],
        }
        runtime = cls(root, record)
        atomic_json(root / "runtime.json", record)
        (root / "runtime-commands").mkdir()
        (root / "admission.lock").touch()
        try:
            await runtime._create(memory_bytes, cpu_cores)
            return runtime
        except BaseException:
            await _finish(runtime.stop("setup_failed"))
            raise

    async def _create(self, memory_bytes, cpu_cores):
        config = {
            "state_dir": str(self.state_dir),
            "mounts": [],
            "owner_exit": self.record["owner_exit"],
            "setup_deadline_monotonic": time.monotonic() + _SETUP_SECONDS,
        }
        for index, value in enumerate(self.record["mounts"]):
            spec = dict(value)
            if spec["kind"] == "fresh" and not spec.get("source"):
                fresh = self.state_dir / "fresh" / str(index)
                fresh.mkdir(parents=True)
                spec["source"] = str(fresh)
            config["mounts"].append(spec)
        config_path = self.state_dir / "keeper-config.json"
        atomic_json(config_path, config)
        self._owner, child = _socket_pair()
        with (self.state_dir / "keeper.log").open("ab", buffering=0) as log:
            try:
                self._keeper = subprocess.Popen(
                    [sys.executable, "-I", str(_HELPER), "keeper", str(config_path), str(child.fileno())],
                    pass_fds=(child.fileno(),),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                )
            finally:
                child.close()
        expected = await _hello(self._owner, self._keeper)
        self.record["keeper_identity"] = expected
        self._save()
        descriptor = pidfd(expected)
        try:
            maximum = self.record["max_runtime"]
            state = await self.manager.start(
                self.record["unit"],
                descriptor,
                runtime=maximum - self.record["grace_seconds"] if maximum is not None else None,
                grace=self.record["grace_seconds"],
                delegate=True,
                memory_bytes=memory_bytes,
                cpu_cores=cpu_cores,
            )
        finally:
            os.close(descriptor)
        cgroup = cgroup_path(state["ControlGroup"])
        self.record.update(cgroup=state["ControlGroup"], cgroup_identity=group_identity(cgroup), manager=state)
        activated = state["ActiveEnterTimestampMonotonic"] / 1_000_000
        self.record["activated_monotonic"] = activated
        self.record["deadline_monotonic"] = activated + maximum if maximum is not None else None
        self.record["deadline_utc"] = (
            time.time() + activated + maximum - time.monotonic() if maximum is not None else None
        )
        self._save()
        config["cgroup"] = str(cgroup)
        atomic_json(config_path, config)
        self._owner.send(b"G")
        await _ready(self._owner)
        if membership(self._keeper.pid) != self.record["cgroup"] + "/keeper":
            raise RuntimeError("Keeper did not enter its delegated leaf")
        self.record["state"] = "running"
        self._save()
        self._keeper_watch = asyncio.create_task(self._watch_keeper())

    async def _watch_keeper(self):
        await _wait_keeper(self._keeper)
        if self.record["state"] == "running":
            await self.stop("keeper_lost")

    async def _stop_owned_unit(
        self, unit: str, group: str | None, expected_group: dict | None, expected_process: dict | None = None
    ) -> dict:
        state = await self.manager.inspect(unit)
        if state.get("ActiveState") not in ("active", "activating", "deactivating"):
            return state
        owned = unit in self.manager.references
        if group:
            owned |= group_matches(cgroup_path(group), expected_group) and state.get("ControlGroup") == group
        if not owned and alive(expected_process):
            current = membership(expected_process["pid"])
            actual = state.get("ControlGroup")
            owned = bool(actual and (current == actual or current.startswith(actual + "/")))
        if not owned:
            raise RuntimeError("Unit identity could not be verified; refusing to stop " + unit)
        return await self.manager.stop(unit, timeout=max(5, state.get("TimeoutStopUSec", 0) / 1_000_000 + 2))

    @classmethod
    async def reopen(cls, state_dir: Path) -> LinuxRuntime:
        """Recover management access, without replacing original owner policy or pipes."""
        root = Path(state_dir).resolve()
        record = _read(root / "runtime.json")
        if record is None:
            raise FileNotFoundError(f"No runtime journal: {root}")
        if record.get("version") != 1:
            raise ValueError("Unsupported runtime journal version")
        _validate_id(record["id"])
        if record["unit"] != f"pdum-hostfork-{record['id']}.scope":
            raise ValueError("Runtime unit does not match its recorded identity")
        return cls(root, record)

    def _save(self):
        try:
            current = _read(self.state_dir / "runtime.json", {})
        except (OSError, ValueError):
            current = {}
        if current.get("state") == "stopped":
            # A stale reopened handle cannot erase the first durable terminal
            # observations after the manager has garbage-collected the unit.
            for key in ("state", "final_manager", "stop_reason", "stopped_at", "cleanup_errors"):
                if key in current:
                    self.record[key] = current[key]
        atomic_json(self.state_dir / "runtime.json", self.record)

    def _command_file(self, command_id: str) -> Path:
        return self.state_dir / "runtime-commands" / command_id / "command.json"

    def _sample_memory_events(self, result: dict) -> None:
        if self.record.get("cgroup"):
            group = cgroup_path(self.record["cgroup"])
            if group_matches(group, self.record.get("cgroup_identity")):
                try:
                    result["memory_events"] = {
                        key: int(value)
                        for key, value in (line.split() for line in (group / "memory.events").read_text().splitlines())
                    }
                    result["memory_events_observed_at"] = time.time()
                except OSError as error:
                    result["memory_events_error"] = str(error)

    def _check_open(self):
        if (self.state_dir / "admission-closed").exists():
            raise RuntimeError("Environment admission is closed")
        if not alive(self.record.get("keeper_identity")):
            raise RuntimeError("Namespace keeper no longer exists")
        deadline = self.record.get("deadline_monotonic")
        if deadline is not None and time.monotonic() >= deadline - self.record["grace_seconds"]:
            raise TimeoutError("Environment termination deadline has arrived")

    async def spawn(
        self,
        argv: list[str],
        *,
        command_id: str,
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        stdin=None,
        stdout=None,
        stderr=None,
    ) -> LinuxCommand:
        """Launch a gated direct child and return only after verified placement and namespace entry."""
        _validate_id(command_id)
        if not argv or any(not isinstance(x, str) or "\x00" in x for x in argv):
            raise ValueError("argv must contain executable arguments without NUL bytes")
        self._check_open()
        task = asyncio.current_task()
        self._launches.add(task)
        lock_fd = os.open(self.state_dir / "admission.lock", os.O_RDWR)
        connection = child = None
        process = None
        stage = f"pdum-hostfork-{self.record['id']}-{command_id}.scope"
        record: dict[str, Any] = {
            "id": command_id,
            "stage_unit": stage,
            "state": "reserved",
            "argv": argv,
            "reserved_at": time.time(),
            "owner": identity(os.getpid()),
        }
        held = False
        reserved = False
        try:
            while True:
                self._check_open()
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    held = True
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.01)
            self._check_open()
            command_root = self._command_file(command_id).parent
            command_root.mkdir()
            reserved = True
            atomic_json(self._command_file(command_id), record)
            setup_deadline = time.monotonic() + _SETUP_SECONDS
            if self.record["deadline_monotonic"] is not None:
                setup_deadline = min(setup_deadline, self.record["deadline_monotonic"])
            config = {
                "state_dir": str(self.state_dir),
                "argv": argv,
                "cwd": str(cwd or Path.cwd()),
                "setup_deadline_monotonic": setup_deadline,
            }
            record["setup_deadline_monotonic"] = setup_deadline
            atomic_json(command_root / "config.json", config)
            group = cgroup_path(self.record["cgroup"]) / "commands" / command_id
            if not group_matches(group.parent.parent, self.record["cgroup_identity"]):
                raise RuntimeError("Environment cgroup identity changed")
            group.mkdir()
            record.update(
                cgroup=self.record["cgroup"] + "/commands/" + command_id, cgroup_identity=group_identity(group)
            )
            atomic_json(self._command_file(command_id), record)
            target_fd = os.open(group / "cgroup.procs", os.O_WRONLY)
            keeper_fd = None
            connection, child = _socket_pair()
            try:
                keeper_fd = pidfd(self.record["keeper_identity"])
                process = await _spawn(
                    sys.executable,
                    "-I",
                    str(_HELPER),
                    "command",
                    str(command_root / "config.json"),
                    str(child.fileno()),
                    str(target_fd),
                    str(keeper_fd),
                    pass_fds=(child.fileno(), target_fd, keeper_fd),
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                    env=env,
                    _abort=connection.close,
                )
            finally:
                os.close(target_fd)
                if keeper_fd is not None:
                    os.close(keeper_fd)
                child.close()
            record.update(identity=await _hello(connection, process), state="gated")
            atomic_json(self._command_file(command_id), record)
            self._check_open()
            maximum = _SETUP_SECONDS
            deadline = self.record["deadline_monotonic"]
            if deadline is not None:
                maximum = min(maximum, deadline - time.monotonic())
            if maximum <= 0:
                raise TimeoutError("No setup budget remains")
            descriptor = pidfd(record["identity"])
            try:
                stage_state = await self.manager.start(stage, descriptor, runtime=maximum, grace=0)
            finally:
                os.close(descriptor)
            record["stage_cgroup"] = stage_state["ControlGroup"]
            record["stage_cgroup_identity"] = group_identity(cgroup_path(stage_state["ControlGroup"]))
            atomic_json(self._command_file(command_id), record)
            self._check_open()
            connection.send(b"G")
            await _ready(connection)
            if membership(process.pid) != record["cgroup"]:
                raise RuntimeError("Command did not enter its recorded cgroup")
            self._check_open()
            record["state"] = "running"
            atomic_json(self._command_file(command_id), record)
            connection.send(b"G")
            command = LinuxCommand(self, process, record)
            self._commands[command_id] = command
            await self.manager.release(stage)
            return command
        except BaseException as error:
            if connection is not None:
                connection.close()
                connection = None
            if process is not None:
                try:
                    signal_identity(record.get("identity"))
                except ProcessLookupError:
                    pass
                # Waiting does not consume pipes, so bounded cleanup must not
                # depend on asyncio's pipe transport reaching EOF.
                until = time.monotonic() + 5
                while process.returncode is None and time.monotonic() < until:
                    await _finish(asyncio.sleep(0.01))
            if reserved:
                try:
                    await _finish(
                        self._stop_owned_unit(
                            stage,
                            record.get("stage_cgroup"),
                            record.get("stage_cgroup_identity"),
                            record.get("identity"),
                        )
                    )
                    await _finish(self.manager.release(stage))
                except (RuntimeError, TimeoutError):
                    pass
            if record.get("cgroup"):
                group = cgroup_path(record["cgroup"])
                if group_matches(group, record.get("cgroup_identity")):
                    try:
                        (group / "cgroup.kill").write_text("1")
                    except FileNotFoundError:
                        pass
            record["state"] = "launch_failed"
            record["launch_error"] = f"{type(error).__name__}: {error}"
            if reserved:
                atomic_json(self._command_file(command_id), record)
            raise
        finally:
            if connection is not None:
                connection.close()
            if child is not None:
                child.close()
            if held:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
            self._launches.discard(task)

    async def inspect(self) -> dict:
        """Return durable intent and current observations without inventing missing results."""
        self.record = _read(self.state_dir / "runtime.json", self.record)
        result = dict(self.record)
        if result["boot_id"] != identity(os.getpid())["boot_id"]:
            result.update(state="stopped", manager={"LoadState": "not-found"}, observation="host_rebooted")
        else:
            result["manager"] = await self.manager.inspect(self.record["unit"])
        result["keeper_alive"] = alive(result.get("keeper_identity"))
        result["commands"] = [
            _read(path) for path in sorted((self.state_dir / "runtime-commands").glob("*/command.json"))
        ]
        for record in result["commands"]:
            path = cgroup_path(record["cgroup"]) if record.get("cgroup") else None
            record["populated"] = bool(path and group_matches(path, record.get("cgroup_identity")) and populated(path))
            if record.get("id") in self._commands:
                record["returncode"] = self._commands[record["id"]].native_process.returncode
        result["keeper_event"] = _read(self.state_dir / "keeper-event.json")
        self._sample_memory_events(result)
        if self.record.get("cgroup"):
            group = cgroup_path(self.record["cgroup"])
            if group_matches(group, self.record.get("cgroup_identity")):
                result["populated"] = populated(group)
            else:
                result["populated"] = False
        return result

    async def detach(self) -> None:
        """Keep the environment after owner departure, without changing its deadline."""
        self.record = _read(self.state_dir / "runtime.json", self.record)
        self._check_open()
        self.record["owner_exit"] = "retain"
        self._save()
        if self._owner is not None:
            self._owner.send(b"D")
            self._owner.close()
            self._owner = None
        await self.manager.close()

    async def stop(self, reason: str = "requested") -> dict:
        """Fence admission, terminate all owned scopes and retain actual cleanup evidence."""
        return await _finish(self._stop(reason))

    async def _stop(self, reason: str) -> dict:
        async with self._stopping:
            errors = []
            try:
                latest = _read(self.state_dir / "runtime.json", self.record)
            except (OSError, ValueError) as error:
                errors.append(f"runtime journal unreadable: {error}")
                latest = self.record
            if latest.get("state") == "stopped":
                self.record = latest
                if self._owner is not None:
                    self._owner.close()
                    self._owner = None
                try:
                    await self.manager.release(self.record["unit"])
                finally:
                    await self.manager.close()
                return dict(self.record)
            try:
                (self.state_dir / "admission-closed").touch(exist_ok=True)
            except OSError as error:
                errors.append(f"admission journal: {error}")
            self.record.update(state="stopping", stop_reason=self.record.get("stop_reason", reason))
            self._sample_memory_events(self.record)
            try:
                self._save()
            except OSError as error:
                errors.append(f"journal: {error}")
            other_tasks = [task for task in self._launches if task is not asyncio.current_task()]
            for task in other_tasks:
                task.cancel()
            if other_tasks:
                await asyncio.gather(*other_tasks, return_exceptions=True)
            same_boot = self.record["boot_id"] == identity(os.getpid())["boot_id"]
            records_by_id = {key: dict(value.record) for key, value in self._commands.items()}
            try:
                for path in (self.state_dir / "runtime-commands").glob("*/command.json"):
                    try:
                        value = _read(path)
                        if value is not None:
                            records_by_id[value["id"]] = value
                    except (OSError, ValueError) as error:
                        errors.append(f"command journal unreadable: {error}")
            except OSError as error:
                errors.append(f"command inventory unreadable: {error}")
            records = list(records_by_id.values())
            for record in records:
                if same_boot:
                    try:
                        signal_identity(record.get("identity")) if record.get("state") != "running" else None
                        await self._stop_owned_unit(
                            record["stage_unit"],
                            record.get("stage_cgroup"),
                            record.get("stage_cgroup_identity"),
                            record.get("identity"),
                        )
                        await self.manager.release(record["stage_unit"])
                    except (OSError, RuntimeError, TimeoutError) as error:
                        errors.append(f"staging {record['id']}: {error}")
            try:
                if same_boot:
                    self.record["final_manager"] = await self._stop_owned_unit(
                        self.record["unit"],
                        self.record.get("cgroup"),
                        self.record.get("cgroup_identity"),
                        self.record.get("keeper_identity"),
                    )
                if self._keeper is not None and self._keeper.returncode is None:
                    signal_identity(self.record.get("keeper_identity"))
                if self._owner is not None:
                    self._owner.close()
                    self._owner = None
                for command in self._commands.values():
                    if command.native_process.returncode is not None:
                        command.record["returncode"] = command.native_process.returncode
                        command.record["signal"] = (
                            -command.native_process.returncode if command.native_process.returncode < 0 else None
                        )
                        atomic_json(self._command_file(command.id), command.record)
            except (OSError, RuntimeError, TimeoutError) as error:
                errors.append(f"environment: {error}")
                # Even a rejected unit identity must not strand our fresh gate.
                if self._owner is not None:
                    self._owner.close()
                    self._owner = None
                signal_identity(self.record.get("keeper_identity"))
            lock_fd = os.open(self.state_dir / "admission.lock", os.O_RDWR)
            try:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    errors.append("Admission still has an in-flight owner; recovery must retry")
                else:
                    if same_boot and self.record.get("cgroup"):
                        group = cgroup_path(self.record["cgroup"])
                        if group_matches(group, self.record.get("cgroup_identity")) and populated(group):
                            errors.append("Environment cgroup remains populated")
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)
            if self._keeper is not None:
                try:
                    await asyncio.wait_for(_wait_keeper(self._keeper), 5)
                except TimeoutError:
                    errors.append("Keeper did not become waitable")
            self.record.update(state="cleanup_pending" if errors else "stopped", cleanup_errors=errors)
            self.record["keeper_event"] = _read(self.state_dir / "keeper-event.json")
            if not errors:
                self.record.setdefault("stopped_at", time.time())
            # Pin manager observations until the detailed result is durable.
            try:
                self._save()
            except BaseException:
                # Retain the in-memory result for the caller, but never require
                # cyclic GC to reclaim a connection after storage failure.
                await self.manager.close()
                raise
            try:
                if not errors and same_boot:
                    await self.manager.reset_failed(self.record["unit"])
                    for record in records:
                        await self.manager.reset_failed(record["stage_unit"])
                await self.manager.release(self.record["unit"])
            finally:
                await self.manager.close()
            return dict(self.record)
