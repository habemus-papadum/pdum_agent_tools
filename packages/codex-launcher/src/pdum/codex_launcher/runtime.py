"""Async subprocess ownership, native readiness, run records and PID-aware recovery.

Codex coordinates concurrent processes in one home natively, so the launcher
does not gate a profile to a single app-server. Every launch or login records
its own run under ``.pdum/runtime/runs/<run-id>/owner.json``; a short mutation
lock serializes launcher edits, logins and disposal only.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import shutil
import signal
import tempfile
import time
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import psutil
from websockets.asyncio.client import unix_connect

from .config import atomic_write, complete_file_operation, native_override, read_config, resolve_executable
from .environment import build_environment
from .errors import LaunchError, OwnershipUncertain, ProfileBusy, ProfileError
from .layout import LAUNCHER_DIR, legacy_layout, runs_dir, runtime_dir, work_dir

if TYPE_CHECKING:
    from pdum.mitm import ProcessorSpec, SidecarConfig


@dataclass(frozen=True)
class LaunchOptions:
    """One-run launcher choices; native settings travel as ``-c`` overrides, never config edits.

    Parameters
    ----------
    model : str or None
        Native model for this run, passed as ``-c model=...``.
    config_overrides : Mapping
        Additional native ``key -> TOML text`` overrides, exactly as ``codex -c`` accepts them.
    isolate : bool or None
        Override the profile's environment isolation for this run.
    """

    executable: str | Path | None = None
    relay: bool = True
    host: str | None = None
    port: int | None = None
    processors: Sequence[Any] = ()
    environment: Mapping[str, str] = field(default_factory=dict)
    environment_mode: str | None = None
    isolate: bool | None = None
    model: str | None = None
    config_overrides: Mapping[str, str] = field(default_factory=dict)
    startup_timeout: float | None = None
    shutdown_timeout: float | None = None
    mitm_config: SidecarConfig | None = None
    mitm_processors: Sequence[ProcessorSpec] = ()

    def native_arguments(self) -> list[str]:
        """Render the ``-c`` override arguments for the native command line."""
        arguments: list[str] = []
        if self.model is not None:
            if not self.model.strip():
                raise ProfileError("Model must be nonempty when supplied")
            arguments.extend(["-c", native_override("model", self.model)])
        for key, value in self.config_overrides.items():
            arguments.extend(["-c", native_override(key, value, raw=True)])
        return arguments


def _identity(pid: int) -> dict[str, Any] | None:
    try:
        process = psutil.Process(pid)
        if process.status() == psutil.STATUS_ZOMBIE:
            return None
        return {"pid": pid, "create_time": process.create_time(), "uid": process.uids().real}
    except psutil.NoSuchProcess:
        return None
    except psutil.AccessDenied as error:
        raise OwnershipUncertain(f"Cannot inspect process {pid}") from error


def _same_process(record: dict[str, Any] | None) -> bool:
    if not record:
        return False
    try:
        actual = _identity(record["pid"])
        return actual is not None and all(actual[key] == record[key] for key in ("pid", "create_time", "uid"))
    except (KeyError, TypeError, ValueError) as error:
        raise OwnershipUncertain("Incomplete process identity in run record") from error


def _prepare_runtime(directory: Path) -> Path:
    """Resolve a profile directory and make sure its launcher runtime tree exists."""
    path = directory.expanduser().resolve()
    if legacy_layout(path):
        raise ProfileError(f"Legacy wrapper layout: {path}; profiles are Codex homes now")
    if not path.is_dir():
        raise ProfileError(f"Profile does not exist: {path}")
    runtime = runtime_dir(path)
    if runtime.is_symlink():
        raise ProfileError("Profile runtime directory must not be a symlink")
    (runtime / "runs").mkdir(mode=0o700, parents=True, exist_ok=True)
    (runtime / "tmp").mkdir(mode=0o700, exist_ok=True)
    return path


class MutationLock:
    """Nonblocking exclusive lock serializing launcher mutations of one profile.

    This never gates launching; Codex coordinates concurrent servers itself.
    """

    def __init__(self, directory: Path):
        self.directory = directory
        self.descriptor: int | None = None

    def acquire(self) -> None:
        self.directory = _prepare_runtime(self.directory)
        path = runtime_dir(self.directory) / "mutation.lock"
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if os.fstat(descriptor).st_ino != path.stat().st_ino:
                raise OwnershipUncertain("Mutation lock inode changed during acquisition")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ProfileBusy(f"Another launcher operation is modifying this profile: {self.directory}") from error
            if (runtime_dir(self.directory) / "disposed").exists():
                raise ProfileError(f"Profile is being removed: {self.directory}")
            self.descriptor = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def close(self) -> None:
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None


@asynccontextmanager
async def mutation_lock(directory: Path) -> AsyncIterator[Path]:
    """Hold the profile mutation lock for an edit, login or disposal.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Yields
    ------
    Path
        Canonical directory whose launcher files may be modified during the context.
    """
    lock = MutationLock(directory)
    lock.acquire()
    try:
        yield lock.directory
    finally:
        lock.close()


def _read_record(path: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(path.read_text())
        if not isinstance(record, dict):
            raise ValueError("not an object")
        return record
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise OwnershipUncertain(f"Cannot read run record: {path}") from error


def _read_runs(directory: Path) -> list[dict[str, Any]]:
    """Read every run record under the profile, oldest first; malformed records surface as errors."""
    runs = runs_dir(directory)
    if not runs.is_dir():
        return []
    records = []
    for entry in sorted(runs.iterdir()):
        path = entry / "owner.json"
        try:
            record = _read_record(path)
        except OwnershipUncertain as error:
            record = {"run_id": entry.name, "state": "unreadable", "error": str(error)}
        if record is not None:
            record.setdefault("run_id", entry.name)
            record["record"] = str(path)
            records.append(record)
    records.sort(key=lambda record: record.get("started_at") or 0)
    return records


def _annotate(record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    try:
        result["server_alive"] = _same_process(record.get("server"))
        result["owner_alive"] = _same_process(record.get("owner"))
    except OwnershipUncertain as error:
        result["server_alive"] = result["owner_alive"] = False
        result["identity_error"] = str(error)
    finished = record.get("state") in {"closed", "failed"}
    result["live"] = result["server_alive"] or (result["owner_alive"] and not finished)
    return result


def open_file_holders(directory: Path) -> list[dict[str, Any]]:
    """List processes of any origin holding files open under a directory.

    Parameters
    ----------
    directory : Path
        Resolved directory to scan for.

    Returns
    -------
    list of dict
        ``pid``, ``name`` and the relative paths held open. Processes that cannot be
        inspected are skipped; this is a hygiene signal, not an exhaustive audit.
    """
    prefix = str(directory.resolve()) + os.sep
    holders = []
    for process in psutil.process_iter(["pid", "name"]):
        try:
            held = sorted({item.path[len(prefix) :] for item in process.open_files() if item.path.startswith(prefix)})
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            continue
        if held:
            holders.append({"pid": process.info["pid"], "name": process.info["name"], "paths": held})
    return holders


async def dispose_profile(directory: Path) -> None:
    """Remove an unused temporary profile, refusing while anything still uses it.

    Parameters
    ----------
    directory : Path
        Temporary profile created by the caller.
    """

    def dispose() -> None:
        lock = MutationLock(directory)
        lock.acquire()
        try:
            live = [run["run_id"] for run in map(_annotate, _read_runs(lock.directory)) if run["live"]]
            if live:
                raise ProfileBusy(f"Profile has live runs {', '.join(live)}; stop them before disposal")
            holders = [
                holder
                for holder in open_file_holders(lock.directory)
                if not (
                    holder["pid"] == os.getpid()
                    and all(path.startswith(LAUNCHER_DIR + "/") for path in holder["paths"])
                )
            ]
            if holders:
                described = ", ".join(f"{holder['name']} ({holder['pid']})" for holder in holders)
                raise ProfileBusy(f"Processes still hold files under this profile: {described}")
            atomic_write(runtime_dir(lock.directory) / "disposed", "disposed\n")
        finally:
            lock.close()
        shutil.rmtree(lock.directory)

    await complete_file_operation(dispose)


async def profile_status(directory: Path) -> dict[str, Any]:
    """Read recorded runs and their live-process state without changing anything.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Returns
    -------
    dict
        Profile path, run records annotated with liveness, and live launcher status.
    """
    path = directory.expanduser().resolve()
    if legacy_layout(path):
        raise ProfileError(f"Legacy wrapper layout: {path}; profiles are Codex homes now")
    if not path.is_dir():
        raise ProfileError(f"Profile does not exist: {path}")
    runs = [_annotate(record) for record in await asyncio.to_thread(_read_runs, path)]
    for run in runs:
        if run["owner_alive"] and run.get("control_socket") and run.get("state") == "ready":
            try:
                async with asyncio.timeout(2):
                    run.update(await _request_control(run["control_socket"], "status"))
            except (OSError, ValueError, TimeoutError):
                run["control_unavailable"] = True
    return {
        "profile": str(path),
        "runs": runs,
        "live_runs": [run["run_id"] for run in runs if run["live"]],
    }


async def _request_control(path: str, method: str, **parameters: Any) -> dict[str, Any]:
    reader, writer = await asyncio.open_unix_connection(path)
    try:
        writer.write(json.dumps({"method": method, **parameters}).encode() + b"\n")
        await writer.drain()
        return json.loads(await reader.readline())
    finally:
        writer.close()
        await writer.wait_closed()


def _select_run(status: dict[str, Any], run_id: str | None, purpose: str) -> dict[str, Any]:
    live = [run for run in status["runs"] if run["live"] and run.get("control_socket")]
    if run_id is not None:
        matching = [run for run in live if run["run_id"] == run_id]
        if not matching:
            raise LaunchError(f"Run {run_id} has no reachable live launcher")
        return matching[0]
    if not live:
        raise LaunchError("Profile has no reachable live launcher")
    if len(live) > 1:
        raise LaunchError(f"Several live runs; select one for {purpose}: {', '.join(run['run_id'] for run in live)}")
    return live[0]


async def configure_profile_capture(
    directory: Path, enabled: bool, *, expected_revision: int | None = None, run_id: str | None = None
) -> dict[str, Any]:
    """Control recording through a running launcher, selected by run when several are live."""
    run = _select_run(await profile_status(directory), run_id, "capture")
    if not run["owner_alive"]:
        raise LaunchError("Run has no reachable live launcher")
    async with asyncio.timeout(15):
        result = await _request_control(
            run["control_socket"], "capture", enabled=enabled, expected_revision=expected_revision
        )
    if "error" in result:
        raise LaunchError(result["error"])
    return result


async def _recover_orphan(run: dict[str, Any], timeout: float) -> None:
    record = run["server"]
    process = psutil.Process(record["pid"])
    command = process.cmdline()
    if record["uid"] != os.getuid():
        raise OwnershipUncertain("Orphan identity does not match the current user")
    if run.get("operation") == "login":
        if (
            command != run.get("process_command")
            or process.exe() != run.get("process_executable")
            or "login" not in command
            or not run.get("executable")
        ):
            raise OwnershipUncertain("Orphan login command or executable no longer matches its recorded identity")
    elif run.get("backend_endpoint") not in command:
        raise OwnershipUncertain("Orphan identity does not match the recorded app-server endpoint")
    if os.getpgid(process.pid) != process.pid:
        raise OwnershipUncertain("Recorded process is no longer its process-group leader")
    if not _same_process(record):
        raise OwnershipUncertain("Recorded process identity changed before recovery; no signal was sent")
    os.killpg(process.pid, signal.SIGTERM)
    deadline = asyncio.get_running_loop().time() + timeout
    while _same_process(record) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    if _same_process(record):
        os.killpg(process.pid, signal.SIGKILL)
        deadline = asyncio.get_running_loop().time() + 2
        while _same_process(record) and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)


async def stop_profile(directory: Path, timeout: float = 10, run_id: str | None = None) -> dict[str, Any]:
    """Stop live launcher runs or recover verified orphans, never merely a matching PID.

    Parameters
    ----------
    directory : Path
        Existing profile directory.
    timeout : float
        Grace interval before verified orphan escalation.
    run_id : str or None
        Stop only this run; None stops every live run recorded for the profile.

    Returns
    -------
    dict
        Final profile status.
    """
    status = await profile_status(directory)
    targets = [run for run in status["runs"] if run["live"] and (run_id is None or run["run_id"] == run_id)]
    if run_id is not None and not targets:
        if not any(run["run_id"] == run_id for run in status["runs"]):
            raise ProfileError(f"Unknown run: {run_id}")
        return status
    for run in targets:
        control = run.get("control_socket")
        if run["owner_alive"] and control:
            try:
                async with asyncio.timeout(timeout):
                    reply = await _request_control(control, "stop")
                    if reply.get("accepted"):
                        deadline = asyncio.get_running_loop().time() + timeout + 2
                        while asyncio.get_running_loop().time() < deadline:
                            current = _annotate(_read_record(Path(run["record"])) or {})
                            if not current["live"]:
                                break
                            await asyncio.sleep(0.05)
            except (OSError, TimeoutError, ValueError):
                pass
        current = _annotate(_read_record(Path(run["record"])) or {})
        if not current["live"]:
            continue
        if current["owner_alive"]:
            raise OwnershipUncertain(
                f"Launcher for run {run['run_id']} is alive but its control socket did not stop it; inspect it"
            )
        if current["server_alive"]:
            await _recover_orphan(current, timeout)
        async with mutation_lock(directory):
            record = await asyncio.to_thread(_read_record, Path(run["record"]))
            if record is not None and record.get("state") not in {"closed", "failed"}:
                if _annotate(record)["live"]:
                    raise OwnershipUncertain(f"Run {run['run_id']} is still alive after recovery; nothing was changed")
                record.update(state="closed", stopped_at=time.time(), recovered=True)
                content = json.dumps(record)
                await complete_file_operation(lambda: atomic_write(Path(run["record"]), content))
    return await profile_status(directory)


async def _readiness(endpoint: str, process: asyncio.subprocess.Process, timeout: float) -> dict[str, Any]:
    async with asyncio.timeout(timeout):
        while process.returncode is None:
            try:
                async with unix_connect(endpoint.removeprefix("unix://"), open_timeout=1, max_size=None) as websocket:
                    await websocket.send(
                        json.dumps(
                            {
                                "id": "pdum-readiness",
                                "method": "initialize",
                                "params": {"clientInfo": {"name": "pdum-codex", "version": "0.0.0"}},
                            }
                        )
                    )
                    while True:
                        response = json.loads(await websocket.recv())
                        if response.get("id") == "pdum-readiness":
                            if "error" in response:
                                raise LaunchError("Codex rejected the readiness initialization")
                            await websocket.send(json.dumps({"method": "initialized"}))
                            return response.get("result", {})
            except OSError:
                await asyncio.sleep(0.05)
        raise LaunchError(f"Codex exited before readiness (exit {process.returncode})")


async def _drain(reader: asyncio.StreamReader, path: Path) -> None:
    with path.open("wb") as stream:
        path.chmod(0o600)
        while chunk := await reader.read(65536):
            await asyncio.to_thread(stream.write, chunk)
        await asyncio.to_thread(stream.flush)


class RunningAppServer:
    """An application-owned app-server, returned only after native readiness."""

    def __init__(self, directory: Path, options: LaunchOptions):
        self.directory = directory.expanduser().resolve()
        self.options = options
        self.run_id = uuid.uuid4().hex
        self.endpoint = ""
        self.backend_endpoint = ""
        self.pid: int | None = None
        self.run_directory: Path | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._relay: Any = None
        self._relay_context: Any = None
        self._sidecar: Any = None
        self._sidecar_context: Any = None
        self._sidecar_monitor: asyncio.Task | None = None
        self._sidecar_final: dict[str, Any] | None = None
        self._control: asyncio.Server | None = None
        self._socket_directory: Path | None = None
        self._drainers: list[asyncio.Task] = []
        self._monitor: asyncio.Task | None = None
        self._close_task: asyncio.Task | None = None
        self._closed = asyncio.Event()
        self._record: dict[str, Any] = {}
        self._shutdown_timeout = 10.0

    async def _journal(self) -> None:
        content = json.dumps(self._record)
        path = self.run_directory / "owner.json"
        await complete_file_operation(lambda: atomic_write(path, content))

    async def _start(self) -> None:
        self.directory = await asyncio.to_thread(_prepare_runtime, self.directory)
        config = await asyncio.to_thread(read_config, self.directory, self.options.executable)
        executable = resolve_executable(self.options.executable or config.executable, self.directory)
        self._shutdown_timeout = self.options.shutdown_timeout or config.shutdown_timeout
        startup_timeout = self.options.startup_timeout or config.startup_timeout
        isolate = config.isolate if self.options.isolate is None else self.options.isolate
        environment = build_environment(
            self.directory, config, self.options.environment, self.options.environment_mode, isolate=isolate
        )
        overrides = self.options.native_arguments()
        self.run_directory = runs_dir(self.directory) / self.run_id
        self.run_directory.mkdir(mode=0o700)
        self._socket_directory = Path(tempfile.mkdtemp(prefix="pdum-codex-sock-"))
        self.backend_endpoint = f"unix://{self._socket_directory / 'app.sock'}"
        arguments = ["app-server", "--listen", self.backend_endpoint, *overrides]
        working_directory = work_dir(self.directory) if isolate else Path.cwd()
        self._record = {
            "run_id": self.run_id,
            "operation": "launch",
            "profile": str(self.directory),
            "state": "starting",
            "owner": _identity(os.getpid()),
            "backend_endpoint": self.backend_endpoint,
            "control_socket": str(self._socket_directory / "control.sock"),
            "executable": str(executable),
            "executable_sha256": await asyncio.to_thread(lambda: hashlib.sha256(executable.read_bytes()).hexdigest()),
            "arguments": arguments,
            "cwd": str(working_directory),
            "isolate": isolate,
            "started_at": time.time(),
            "run_directory": str(self.run_directory),
        }
        await self._journal()
        if self.options.mitm_config is not None:
            try:
                from pdum.mitm import open_sidecar
            except ImportError as error:
                raise LaunchError("Install habemus-papadum-codex-launcher[mitm] to enable interception") from error
            self._sidecar_context = open_sidecar(self.options.mitm_config, processors=self.options.mitm_processors)
            self._sidecar = await self._sidecar_context.__aenter__()
            environment = await asyncio.to_thread(self._sidecar.connection.environment, environment, trust="openssl")
            self._record["mitm"] = {
                "pid": self._sidecar.pid,
                "run_id": self._sidecar.run_id,
                "proxy_url": self._sidecar.connection.proxy_url,
                "capture_path": str(self._sidecar.capture_path) if self._sidecar.capture_path else None,
            }
            await self._journal()
        spawning = asyncio.create_task(
            asyncio.create_subprocess_exec(
                str(executable),
                *arguments,
                cwd=working_directory,
                env=environment,
                start_new_session=True,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        )
        cancelled = False
        try:
            self._process = await asyncio.shield(spawning)
        except asyncio.CancelledError:
            self._process = await spawning
            cancelled = True
        self.pid = self._process.pid
        self._record["server"] = _identity(self.pid)
        self._drainers = [
            asyncio.create_task(_drain(self._process.stdout, self.run_directory / "stdout.log")),
            asyncio.create_task(_drain(self._process.stderr, self.run_directory / "stderr.log")),
        ]
        await self._journal()
        if cancelled:
            raise asyncio.CancelledError
        try:
            initialization = await _readiness(self.backend_endpoint, self._process, startup_timeout)
        except TimeoutError as error:
            raise LaunchError(f"Codex readiness timed out; inspect {self.run_directory / 'stderr.log'}") from error
        self._record["server_info"] = initialization
        self.endpoint = self.backend_endpoint
        if self.options.relay:
            from .relay import open_relay

            self._relay_context = open_relay(
                self.backend_endpoint,
                host=self.options.host if self.options.host is not None else config.host,
                port=self.options.port if self.options.port is not None else config.port,
                processors=self.options.processors,
            )
            self._relay = await self._relay_context.__aenter__()
            self.endpoint = self._relay.endpoint
        self._control = await asyncio.start_unix_server(self._handle_control, self._record["control_socket"])
        self._record.update(state="ready", endpoint=self.endpoint)
        await self._journal()
        self._monitor = asyncio.create_task(self._watch())
        if self._sidecar is not None:
            self._sidecar_monitor = asyncio.create_task(self._watch_sidecar())

    async def _watch_sidecar(self) -> None:
        failure = await self._sidecar.wait_failure()
        if failure is not None and self._close_task is None:
            self._record["sidecar_failure"] = str(failure)
            asyncio.create_task(self.aclose())

    async def configure_capture(self, enabled: bool, *, expected_revision: int | None = None) -> dict[str, Any]:
        """Toggle an already-launched sidecar's recording without reconnecting traffic."""
        if self._sidecar is None:
            raise LaunchError("No MITM sidecar was launched; interception requires a new launch")
        return await self._sidecar.configure_capture(enabled, expected_revision=expected_revision)

    async def _watch(self) -> None:
        await self._process.wait()
        if self._close_task is None:
            await self.aclose()

    async def _handle_control(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(10):
                request = json.loads(await reader.readline())
                if request.get("method") == "status":
                    response = await self.status()
                elif request.get("method") == "stop":
                    response = {"accepted": True}
                    asyncio.create_task(self.aclose())
                elif request.get("method") == "capture":
                    try:
                        response = await self.configure_capture(
                            request.get("enabled"), expected_revision=request.get("expected_revision")
                        )
                    except (RuntimeError, TypeError, ValueError) as error:
                        response = {"error": str(error)}
                else:
                    response = {"error": "Unknown control method"}
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
        except (OSError, ValueError, TimeoutError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def status(self) -> dict[str, Any]:
        """Return lifecycle, endpoint and optional observer status.

        Returns
        -------
        dict
            Non-secret process and relay information.
        """
        result = dict(self._record)
        if self._relay is not None:
            result["relay"] = await self._relay.status()
        if self._sidecar is not None:
            try:
                result["capture"] = (
                    self._sidecar_final if self._sidecar_final is not None else await self._sidecar.status()
                )
            except (RuntimeError, TimeoutError) as error:
                result["capture"] = {"error": str(error)}
        return result

    async def wait(self) -> int:
        """Wait for process exit and owned-resource cleanup.

        Returns
        -------
        int
            Native subprocess return code.
        """
        await self._closed.wait()
        return self._process.returncode if self._process is not None else -1

    async def aclose(self) -> None:
        """Idempotently stop owned resources; cancellation does not skip cleanup."""
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        try:
            await asyncio.shield(self._close_task)
        except asyncio.CancelledError:
            await self._close_task
            raise

    async def _close(self) -> None:
        failures: list[str] = []
        try:
            if self._sidecar_monitor is not None:
                self._sidecar_monitor.cancel()
                await asyncio.gather(self._sidecar_monitor, return_exceptions=True)
            if self._control:
                self._control.close()
                await self._control.wait_closed()
            if self._relay_context:
                try:
                    await self._relay_context.__aexit__(None, None, None)
                except Exception as error:
                    failures.append(f"Relay shutdown failed: {type(error).__name__}")
            if self._process is not None:
                descendants = []
                if self._process.returncode is None:
                    try:
                        descendants = [
                            identity
                            for child in psutil.Process(self._process.pid).children(recursive=True)
                            if (identity := _identity(child.pid)) is not None
                        ]
                    except psutil.NoSuchProcess:
                        pass
                if self._process.returncode is None:
                    try:
                        os.killpg(self._process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(self._process.wait(), self._shutdown_timeout)
                    except TimeoutError:
                        try:
                            os.killpg(self._process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await self._process.wait()
                for descendant in descendants:
                    if _same_process(descendant):
                        try:
                            os.kill(descendant["pid"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                try:
                    async with asyncio.timeout(self._shutdown_timeout):
                        results = await asyncio.gather(*self._drainers, return_exceptions=True)
                    if any(isinstance(result, BaseException) for result in results):
                        failures.append("Process diagnostic output could not be completely saved")
                except TimeoutError:
                    failures.append("Process diagnostic pipes did not close before the shutdown deadline")
            if self._sidecar_context is not None:
                try:
                    if self._sidecar is not None:
                        self._sidecar_final = await self._sidecar.aclose()
                    await self._sidecar_context.__aexit__(None, None, None)
                except Exception as error:
                    failures.append(f"MITM shutdown failed: {type(error).__name__}")
            if self._record:
                self._record.update(state="closed", stopped_at=time.time(), cleanup_errors=failures)
                if self._process:
                    self._record["returncode"] = self._process.returncode
                await self._journal()
            if self._socket_directory:
                await asyncio.to_thread(shutil.rmtree, self._socket_directory, True)
        finally:
            self._closed.set()


@asynccontextmanager
async def launch(directory: Path, options: LaunchOptions | None = None) -> AsyncIterator[RunningAppServer]:
    """Launch an app-server against a profile and own it for the context lifetime.

    Parameters
    ----------
    directory : Path
        Existing profile, managed or a bare Codex home; no implicit creation.
    options : LaunchOptions or None
        Optional runtime overrides, native ``-c`` overrides and relay processors.

    Yields
    ------
    RunningAppServer
        Ready server whose endpoint accepts an independent client initialization.
    """
    server = RunningAppServer(directory, options or LaunchOptions())
    try:
        await server._start()
        yield server
    finally:
        await server.aclose()


async def login_chatgpt(directory: Path, *, device_auth: bool = False) -> int:
    """Run native interactive login against this profile's home.

    Parameters
    ----------
    directory : Path
        Existing profile directory.
    device_auth : bool
        Request Codex's device-code login flow.

    Returns
    -------
    int
        Native login exit code; zero indicates successful native completion.
    """
    lock = MutationLock(directory)
    lock.acquire()
    path = lock.directory
    process = None
    record: dict[str, Any] = {}
    run_id = uuid.uuid4().hex
    run_directory = runs_dir(path) / run_id

    async def publish() -> None:
        content = json.dumps(record)
        await complete_file_operation(lambda: atomic_write(run_directory / "owner.json", content))

    try:
        config = await asyncio.to_thread(read_config, path)
        arguments = [str(resolve_executable(config.executable)), "login"]
        if device_auth:
            arguments.append("--device-auth")
        run_directory.mkdir(mode=0o700)
        record = {
            "run_id": run_id,
            "operation": "login",
            "profile": str(path),
            "state": "starting",
            "owner": _identity(os.getpid()),
            "executable": arguments[0],
            "arguments": arguments[1:],
            "started_at": time.time(),
            "run_directory": str(run_directory),
        }
        await publish()
        spawning = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *arguments,
                cwd=work_dir(path) if config.isolate else Path.cwd(),
                env=build_environment(path, config),
                start_new_session=True,
            )
        )
        cancelled = False
        try:
            process = await asyncio.shield(spawning)
        except asyncio.CancelledError:
            process = await spawning
            cancelled = True
        record["server"] = _identity(process.pid)
        try:
            observed = psutil.Process(process.pid)
            record["process_command"] = observed.cmdline()
            record["process_executable"] = observed.exe()
        except psutil.NoSuchProcess:
            pass
        record["state"] = "authenticating"
        await publish()
        if cancelled:
            raise asyncio.CancelledError
        return await process.wait()
    finally:
        try:
            if process is not None and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), config.shutdown_timeout)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            if record:
                record.update(state="closed", stopped_at=time.time())
                if process is not None:
                    record["returncode"] = process.returncode
                await publish()
        finally:
            lock.close()
