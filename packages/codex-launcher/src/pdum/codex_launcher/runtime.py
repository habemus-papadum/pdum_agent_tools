"""Async subprocess ownership, native readiness, and PID-aware recovery."""

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

from .config import atomic_write, complete_file_operation, read_config, resolve_executable
from .environment import build_environment
from .errors import LaunchError, OwnershipUncertain, ProfileBusy, ProfileError

if TYPE_CHECKING:
    from pdum.mitm import ProcessorSpec, SidecarConfig


@dataclass(frozen=True)
class LaunchOptions:
    """One-run launcher overrides; native model options remain native config."""

    executable: str | Path | None = None
    relay: bool = True
    host: str | None = None
    port: int | None = None
    processors: Sequence[Any] = ()
    environment: Mapping[str, str] = field(default_factory=dict)
    environment_mode: str | None = None
    startup_timeout: float | None = None
    shutdown_timeout: float | None = None
    mitm_config: SidecarConfig | None = None
    mitm_processors: Sequence[ProcessorSpec] = ()


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
        raise OwnershipUncertain("Incomplete process identity in owner journal") from error


def _read_owner(directory: Path) -> dict[str, Any] | None:
    path = directory / "runtime" / "owner.json"
    try:
        owner = json.loads(path.read_text())
        if not isinstance(owner, dict):
            raise ValueError("not an object")
        return owner
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise OwnershipUncertain(f"Cannot read ownership journal: {path}") from error


class _Lease:
    def __init__(self, directory: Path):
        self.directory = directory.expanduser().resolve()
        self.descriptor: int | None = None

    def acquire(self) -> None:
        if not (self.directory / "launcher.toml").is_file():
            raise ProfileError(f"Profile does not exist: {self.directory}")
        runtime = self.directory / "runtime"
        if runtime.is_symlink():
            raise ProfileError("Profile runtime directory must not be a symlink")
        runtime.mkdir(mode=0o700, exist_ok=True)
        path = runtime / "lease.lock"
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if os.fstat(descriptor).st_ino != path.stat().st_ino:
                raise OwnershipUncertain("Profile lease inode changed during acquisition")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                owner = _read_owner(self.directory) or {}
                pid = (owner.get("server") or {}).get("pid", "unknown")
                raise ProfileBusy(
                    f"Profile busy (server PID {pid}): {self.directory}. Use pdum-codex --profile-dir PATH status/stop."
                ) from error
            if (runtime / "disposed").exists():
                raise ProfileError(f"Profile is being removed: {self.directory}")
            owner = _read_owner(self.directory)
            if owner and owner.get("state") not in {"closed", "failed"}:
                if _same_process(owner.get("server")) or _same_process(owner.get("owner")):
                    raise OwnershipUncertain(
                        "Lease is free but a recorded owner is alive; inspect the profile before reuse"
                    )
            self.descriptor = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def close(self) -> None:
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None


@asynccontextmanager
async def profile_lease(directory: Path) -> AsyncIterator[Path]:
    """Lease a stopped profile for a mutation without deleting the lock inode.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Yields
    ------
    Path
        Canonical directory owned for the duration of the context.
    """
    lease = _Lease(directory)
    lease.acquire()
    try:
        yield lease.directory
    finally:
        lease.close()


async def dispose_profile(directory: Path) -> None:
    """Mark and remove an unused temporary profile, refusing live ownership.

    Parameters
    ----------
    directory : Path
        Temporary profile created by the caller.
    """

    def dispose() -> None:
        lease = _Lease(directory)
        lease.acquire()
        try:
            atomic_write(lease.directory / "runtime" / "disposed", "disposed\n")
        finally:
            lease.close()
        shutil.rmtree(lease.directory)

    await complete_file_operation(dispose)


async def profile_status(directory: Path) -> dict[str, Any]:
    """Read recorded process identity and current lease state without changing auth.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Returns
    -------
    dict
        Non-secret journal data with live-process and lock observations.
    """
    path = directory.expanduser().resolve()
    if not (path / "launcher.toml").is_file():
        raise ProfileError(f"Profile does not exist: {path}")
    owner = await asyncio.to_thread(_read_owner, path) or {"state": "stopped"}
    result = dict(owner)
    result["profile"] = str(path)
    result["journal"] = str(path / "runtime" / "owner.json")
    result["server_alive"] = _same_process(owner.get("server"))
    result["owner_alive"] = _same_process(owner.get("owner"))
    lock = path / "runtime" / "lease.lock"
    if not lock.exists():
        result["locked"] = False
    else:
        descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result["locked"] = False
            except BlockingIOError:
                result["locked"] = True
        finally:
            os.close(descriptor)
    if result["owner_alive"] and owner.get("control_socket") and owner.get("state") == "ready":
        try:
            async with asyncio.timeout(2):
                result.update(await _request_control(owner["control_socket"], "status"))
        except (OSError, ValueError, TimeoutError):
            result["control_unavailable"] = True
    return result


async def _request_control(path: str, method: str, **parameters: Any) -> dict[str, Any]:
    reader, writer = await asyncio.open_unix_connection(path)
    try:
        writer.write(json.dumps({"method": method, **parameters}).encode() + b"\n")
        await writer.drain()
        return json.loads(await reader.readline())
    finally:
        writer.close()
        await writer.wait_closed()


async def configure_profile_capture(
    directory: Path, enabled: bool, *, expected_revision: int | None = None
) -> dict[str, Any]:
    """Control recording through a running profile's owner, without taking its lease."""
    owner = await asyncio.to_thread(_read_owner, directory.expanduser().resolve())
    if not owner or not _same_process(owner.get("owner")) or not owner.get("control_socket"):
        raise LaunchError("Profile has no reachable live launcher")
    async with asyncio.timeout(15):
        result = await _request_control(
            owner["control_socket"], "capture", enabled=enabled, expected_revision=expected_revision
        )
    if "error" in result:
        raise LaunchError(result["error"])
    return result


async def stop_profile(directory: Path, timeout: float = 10) -> dict[str, Any]:
    """Stop a live owner or recover a verified orphan, never merely a matching PID.

    Parameters
    ----------
    directory : Path
        Existing profile directory.
    timeout : float
        Grace interval before verified orphan escalation.

    Returns
    -------
    dict
        Final non-secret profile status.
    """
    state = await profile_status(directory)
    if not state["locked"] and not state["server_alive"] and state.get("state") in {"closed", "failed", "stopped"}:
        return state
    control = state.get("control_socket")
    if state["owner_alive"] and control:
        try:
            async with asyncio.timeout(timeout):
                reply = await _request_control(control, "stop")
                if reply.get("accepted"):
                    deadline = asyncio.get_running_loop().time() + timeout + 2
                    while asyncio.get_running_loop().time() < deadline:
                        state = await profile_status(directory)
                        if not state["locked"]:
                            return state
                        await asyncio.sleep(0.05)
        except (OSError, TimeoutError, ValueError):
            pass
    state = await profile_status(directory)
    recovery_run_id = state.get("run_id")
    if state["owner_alive"]:
        raise OwnershipUncertain("Launcher is alive but its control socket did not stop it; inspect before recovery")
    if state["server_alive"]:
        record = state["server"]
        process = psutil.Process(record["pid"])
        command = process.cmdline()
        if record["uid"] != os.getuid():
            raise OwnershipUncertain("Orphan identity does not match the current user")
        if state.get("operation") == "login":
            if (
                command != state.get("process_command")
                or process.exe() != state.get("process_executable")
                or "login" not in command
                or not state.get("executable")
            ):
                raise OwnershipUncertain("Orphan login command or executable no longer matches its recorded identity")
        elif state.get("backend_endpoint") not in command:
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
    state = await profile_status(directory)
    if state["locked"]:
        raise OwnershipUncertain("Profile remains leased, possibly by an owned descendant; no lock was removed")
    async with profile_lease(directory) as path:
        owner = await asyncio.to_thread(_read_owner, path)
        if owner is not None:
            if owner.get("run_id") != recovery_run_id:
                raise OwnershipUncertain("Profile ownership changed during recovery; the replacement was not modified")
            owner.update(state="closed", stopped_at=time.time(), recovered=True)
            await complete_file_operation(lambda: atomic_write(path / "runtime" / "owner.json", json.dumps(owner)))
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
        self._lease = _Lease(self.directory)
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
        await complete_file_operation(lambda: atomic_write(self.directory / "runtime" / "owner.json", content))

    async def _start(self) -> None:
        self._lease.acquire()
        config = await asyncio.to_thread(read_config, self.directory)
        executable = resolve_executable(self.options.executable or config.executable, self.directory)
        self._shutdown_timeout = self.options.shutdown_timeout or config.shutdown_timeout
        startup_timeout = self.options.startup_timeout or config.startup_timeout
        environment = build_environment(self.directory, config, self.options.environment, self.options.environment_mode)
        run_directory = self.directory / "runtime" / "runs" / self.run_id
        run_directory.mkdir(mode=0o700)
        self._socket_directory = Path(tempfile.mkdtemp(prefix="pdum-codex-sock-"))
        self.backend_endpoint = f"unix://{self._socket_directory / 'app.sock'}"
        self._record = {
            "run_id": self.run_id,
            "profile": str(self.directory),
            "state": "starting",
            "owner": _identity(os.getpid()),
            "backend_endpoint": self.backend_endpoint,
            "control_socket": str(self._socket_directory / "control.sock"),
            "executable": str(executable),
            "executable_sha256": await asyncio.to_thread(lambda: hashlib.sha256(executable.read_bytes()).hexdigest()),
            "started_at": time.time(),
            "run_directory": str(run_directory),
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
                "app-server",
                "--listen",
                self.backend_endpoint,
                cwd=self.directory / "work",
                env=environment,
                start_new_session=True,
                pass_fds=(self._lease.descriptor,),
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
            asyncio.create_task(_drain(self._process.stdout, run_directory / "stdout.log")),
            asyncio.create_task(_drain(self._process.stderr, run_directory / "stderr.log")),
        ]
        await self._journal()
        if cancelled:
            raise asyncio.CancelledError
        try:
            initialization = await _readiness(self.backend_endpoint, self._process, startup_timeout)
        except TimeoutError as error:
            raise LaunchError(f"Codex readiness timed out; inspect {run_directory / 'stderr.log'}") from error
        self._record["server_info"] = initialization
        lease_path = str(self.directory / "runtime" / "lease.lock")
        opened = await asyncio.to_thread(lambda: psutil.Process(self.pid).open_files())
        if not any(item.path == lease_path for item in opened):
            raise LaunchError(
                "Selected executable did not preserve the profile lease descriptor; wrapper is unsupported"
            )
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
                await asyncio.to_thread(shutil.rmtree, self._socket_directory)
        finally:
            self._lease.close()
            self._closed.set()


@asynccontextmanager
async def launch(directory: Path, options: LaunchOptions | None = None) -> AsyncIterator[RunningAppServer]:
    """Launch an isolated, leased app-server and own it for the context lifetime.

    Parameters
    ----------
    directory : Path
        Existing profile; no implicit creation or caller configuration import.
    options : LaunchOptions or None
        Optional runtime overrides and relay processors.

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
    """Run native interactive login against this profile's isolated home.

    Parameters
    ----------
    directory : Path
        Stopped profile directory.
    device_auth : bool
        Request Codex's device-code login flow.

    Returns
    -------
    int
        Native login exit code; zero indicates successful native completion.
    """
    lease = _Lease(directory)
    lease.acquire()
    path = lease.directory
    process = None
    record = {}

    async def publish() -> None:
        writing = asyncio.create_task(
            asyncio.to_thread(atomic_write, path / "runtime" / "owner.json", json.dumps(record))
        )
        try:
            await asyncio.shield(writing)
        except asyncio.CancelledError:
            await writing
            raise

    try:
        config = await asyncio.to_thread(read_config, path)
        arguments = [str(resolve_executable(config.executable)), "login"]
        if device_auth:
            arguments.append("--device-auth")
        record = {
            "run_id": uuid.uuid4().hex,
            "operation": "login",
            "profile": str(path),
            "state": "starting",
            "owner": _identity(os.getpid()),
            "executable": arguments[0],
            "arguments": arguments[1:],
            "started_at": time.time(),
        }
        await publish()
        spawning = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *arguments,
                cwd=path / "work",
                env=build_environment(path, config),
                start_new_session=True,
                pass_fds=(lease.descriptor,),
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
            lease.close()
