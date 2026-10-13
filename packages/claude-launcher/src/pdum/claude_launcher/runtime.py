"""Foreground ownership of Claude processes; the official SDK stays in the client."""

from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psutil

from .authentication import build_environment
from .errors import LauncherError
from .profiles import Profile, resolve_executable

Receive = Callable[[], Awaitable[str | bytes | None]]
Send = Callable[[str], Awaitable[None]]
Close = Callable[[int, str], Awaitable[None]]
Observe = Callable[[str, str, bytes], None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class LaunchOptions:
    """Explicit per-worker options; turn and spend limits are opt-in.

    Parameters
    ----------
    model
        Override the profile's native Claude model selection.
    permission_mode
        Native permission mode, defaulting to the trusted operator's bypass mode.
    sandbox
        Enable the native sandbox when explicitly requested.
    tools
        Native tool names; ``None`` preserves defaults, an empty tuple disables tools.
    environment
        Explicit child environment additions, for example a scoped proxy. Profile
        HOME and config locations remain owned by the profile.
    """

    model: str | None = None
    permission_mode: str = "bypassPermissions"
    sandbox: bool = False
    tools: tuple[str, ...] | None = None
    max_turns: int | None = None
    max_budget_usd: float | None = None
    environment: Mapping[str, str] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if self.max_turns is not None and self.max_turns <= 0:
            raise ValueError("max_turns must be positive")
        if self.max_budget_usd is not None and self.max_budget_usd <= 0:
            raise ValueError("max_budget_usd must be positive")
        if set(self.environment) & {"HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR", "USERPROFILE"}:
            raise ValueError("Worker environment cannot replace profile isolation directories")


@dataclass
class Worker:
    """One allocated controller lifetime, independent of other workers in its profile."""

    id: str
    profile_id: str
    conversation_id: str
    options: LaunchOptions = field(repr=False)
    resume: bool = False
    state: str = "waiting"
    created_at: str = field(default_factory=_now)
    started_at: str | None = None
    stopped_at: str | None = None
    reason: str | None = None
    pid: int | None = None
    exit_code: int | None = None
    transport_errors: int = 0
    observation_errors: int = 0
    cleanup_errors: int = 0
    input_bytes: int = 0
    output_bytes: int = 0
    stderr_bytes: int = 0
    _process: asyncio.subprocess.Process | None = field(default=None, repr=False)
    _identity: psutil.Process | None = field(default=None, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _bridge: asyncio.Task[Any] | None = field(default=None, repr=False)
    _stop: asyncio.Task[None] | None = field(default=None, repr=False)
    _stderr: asyncio.Task[None] | None = field(default=None, repr=False)
    _close: Close | None = field(default=None, repr=False)

    def status(self) -> dict[str, Any]:
        """Return management metadata without environment or transcript payloads."""
        return {
            "id": self.id,
            "profile_id": self.profile_id,
            "conversation_id": self.conversation_id,
            "state": self.state,
            "pid": self.pid,
            "exit_code": self.exit_code,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "stopped_at": self.stopped_at,
            "reason": self.reason,
            "transport_errors": self.transport_errors,
            "observation_errors": self.observation_errors,
            "cleanup_errors": self.cleanup_errors,
            "input_bytes": self.input_bytes,
            "output_bytes": self.output_bytes,
            "stderr_bytes": self.stderr_bytes,
        }


def worker_arguments(profile: Profile, worker: Worker) -> list[str]:
    """Build the stream-JSON launch recipe without constructing an SDK query."""
    options = worker.options
    args = [
        "--output-format=stream-json",
        "--verbose",
        "--input-format=stream-json",
        f"--model={options.model or profile.model}",
        "--permission-prompt-tool=stdio",
        f"--permission-mode={options.permission_mode}",
        "--include-partial-messages",
        f"--setting-sources={','.join(profile.setting_sources)}",
        '--settings={"sandbox":{"enabled":' + str(options.sandbox).lower() + "}}",
        f"--{'resume' if worker.resume else 'session-id'}={worker.conversation_id}",
    ]
    if options.tools is not None:
        args.append(f"--tools={','.join(options.tools)}")
    if options.max_turns is not None:
        args.append(f"--max-turns={options.max_turns}")
    if options.max_budget_usd is not None:
        args.append(f"--max-budget-usd={options.max_budget_usd}")
    return args


class ClaudeManager:
    """Own independent worker processes in a foreground application.

    Parameters
    ----------
    profiles
        Named profiles. Several workers may share each profile.
    observer
        Optional synchronous enqueue hook accepting worker ID, direction and
        copied bytes. It must not parse, export or block on this forwarding path.
    stop_timeout
        Grace period per terminate/kill phase, in seconds.
    """

    def __init__(
        self,
        profiles: Mapping[str, Profile],
        *,
        observer: Observe | None = None,
        stop_timeout: float = 3.0,
    ) -> None:
        if stop_timeout <= 0:
            raise ValueError("stop_timeout must be positive")
        self.profiles = dict(profiles)
        self._observer = observer
        self._stop_timeout = stop_timeout
        self._workers: dict[str, Worker] = {}
        self._closed = False
        self._closing: asyncio.Task[None] | None = None

    async def allocate(
        self, profile_id: str, *, resume: str | None = None, options: LaunchOptions | None = None
    ) -> Worker:
        """Allocate metadata; native launch waits for the first SDK connection.

        Parameters
        ----------
        profile_id
            Registered profile name.
        resume
            Existing conversation UUID. The management adapter validates that it
            belongs to this profile and workspace before calling this method.
        options
            Optional per-worker native options.
        """
        if self._closed:
            raise RuntimeError("Claude manager is closing")
        if profile_id not in self.profiles:
            raise KeyError(profile_id)
        conversation_id = str(UUID(resume)) if resume is not None else str(uuid4())
        worker = Worker(str(uuid4()), profile_id, conversation_id, options or LaunchOptions(), resume is not None)
        self._workers[worker.id] = worker
        return worker

    def worker(self, worker_id: str) -> Worker:
        """Look up an allocation, including its final status after disconnect."""
        return self._workers[worker_id]

    def list_workers(self) -> list[dict[str, Any]]:
        """Return current and completed controller lifetimes."""
        return [worker.status() for worker in self._workers.values()]

    def observe(self, worker: Worker, direction: str, payload: bytes) -> None:
        """Enqueue a copy for inspection without failing the live transport."""
        if self._observer is not None:
            try:
                self._observer(worker.id, direction, memoryview(payload).tobytes())
            except Exception:
                worker.observation_errors += 1

    async def _attach(self, worker_id: str, close: Close | None) -> Worker:
        worker = self.worker(worker_id)
        async with worker._lock:
            if self._closed or worker.state != "waiting":
                raise RuntimeError("Worker already claimed or stopped; allocate a new controller lifetime")
            worker.state = "starting"
            worker._bridge = asyncio.current_task()
            worker._close = close
            profile = self.profiles[worker.profile_id]
            try:
                executable = resolve_executable(profile.executable)
                environment = await build_environment(profile)
                environment.update(worker.options.environment)
                spawning = asyncio.create_task(
                    asyncio.create_subprocess_exec(
                        str(executable),
                        *worker_arguments(profile, worker),
                        cwd=profile.workspace,
                        env=environment,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        start_new_session=os.name != "nt",
                    )
                )
                try:
                    process = await asyncio.shield(spawning)
                except asyncio.CancelledError:
                    # Subprocess creation itself cannot safely be abandoned: it
                    # can create a child after its awaiter has been cancelled.
                    process = await spawning
                    self._record_process(worker, process)
                    raise
                self._record_process(worker, process)
                worker.state = "connected"
                return worker
            except LauncherError as error:
                worker.state = "failed"
                worker.reason = str(error)
                raise
            except BaseException:
                worker.state = "failed"
                worker.reason = worker.reason or "worker launch failed"
                raise

    def _record_process(self, worker: Worker, process: asyncio.subprocess.Process) -> None:
        worker._process = process
        worker.pid = process.pid
        worker.started_at = _now()
        try:
            worker._identity = psutil.Process(process.pid)
            worker._identity.create_time()
        except psutil.NoSuchProcess:
            pass
        worker._stderr = asyncio.create_task(self._drain_stderr(worker))

    async def _drain_stderr(self, worker: Worker) -> None:
        assert worker._process is not None and worker._process.stderr is not None
        while data := await worker._process.stderr.read(65536):
            worker.stderr_bytes += len(data)
            self.observe(worker, "stderr", data)

    async def bridge(self, worker_id: str, receive: Receive, send: Send, close: Close | None = None) -> None:
        """Connect one official SDK transport to its lazily launched native process.

        Parameters
        ----------
        receive
            Await a text/binary transport chunk; return ``None`` on disconnect.
        send
            Send a text chunk. UTF-8 boundaries are preserved; NDJSON boundaries
            remain the SDK's responsibility.
        close
            Optional callback accepting WebSocket close code and reason.
        """
        from .relay import bridge_worker

        await bridge_worker(self, worker_id, receive, send, close)

    async def stop(self, worker_id: str, reason: str = "explicit stop") -> dict[str, Any]:
        """End an owned controller lifetime without deleting its conversation."""
        worker = self.worker(worker_id)
        if worker._stop is None:
            worker.reason = worker.reason or reason
            worker._stop = asyncio.create_task(self._stop_worker(worker, asyncio.current_task()))
        await asyncio.shield(worker._stop)
        return worker.status()

    async def _stop_worker(self, worker: Worker, caller: asyncio.Task[Any] | None) -> None:
        if worker._bridge is not None and worker._bridge is not caller:
            worker._bridge.cancel()
        async with worker._lock:
            failed = worker.state == "failed" or worker.transport_errors > 0
            worker.state = "stopping"
            process = worker._process
            if process is not None:
                identities = self._owned_tree(worker)
                if process.stdin is not None:
                    process.stdin.close()
                await self._wait_stopped(process, identities, 0.2)
                if self._still_running(process, identities):
                    self._signal_owned(worker, identities, signal.SIGTERM)
                    await self._wait_stopped(process, identities, self._stop_timeout)
                if self._still_running(process, identities):
                    self._signal_owned(worker, identities, signal.SIGKILL)
                    await self._wait_stopped(process, identities, self._stop_timeout)
                if self._still_running(process, identities):
                    worker.cleanup_errors += 1
                worker.exit_code = process.returncode
                if worker.reason == "worker output closed" and worker.exit_code not in {None, 0}:
                    failed = True
            if worker._stderr is not None:
                done, _ = await asyncio.wait({worker._stderr}, timeout=self._stop_timeout)
                if not done:
                    worker.cleanup_errors += 1
                    worker._stderr.cancel()
                results = await asyncio.gather(worker._stderr, return_exceptions=True)
                if any(isinstance(result, Exception) for result in results):
                    worker.cleanup_errors += 1
            self._close_owned_pipes(worker)
            worker.state = "failed" if failed or worker.cleanup_errors else "stopped"
            worker.stopped_at = _now()
        if worker._close is not None:
            try:
                await asyncio.wait_for(
                    worker._close(1011 if worker.state == "failed" or worker.transport_errors else 1000, worker.reason),
                    self._stop_timeout,
                )
            except Exception:
                worker.transport_errors += 1

    @staticmethod
    def _close_owned_pipes(worker: Worker) -> None:
        process = worker._process
        if process is not None and process.returncode is not None:
            # asyncio exposes no public close method on Process's read streams.
            # Close our own transport handles after PID exit, including when an
            # escaped descendant still holds the pipe's opposite end. This does
            # not signal a process whose identity we no longer own.
            process._transport.close()

    @staticmethod
    def _owned_tree(worker: Worker) -> list[psutil.Process]:
        identity = worker._identity
        if identity is None:
            return []
        try:
            if identity.is_running():
                return [identity, *identity.children(recursive=True)]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        return []

    @staticmethod
    def _alive(identity: psutil.Process) -> bool:
        try:
            return identity.is_running() and identity.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
        except psutil.AccessDenied:
            # Permission changes cannot be mistaken for successful cleanup.
            return True

    @classmethod
    def _still_running(cls, process: asyncio.subprocess.Process, identities: list[psutil.Process]) -> bool:
        return process.returncode is None or any(cls._alive(identity) for identity in identities)

    @classmethod
    async def _wait_stopped(
        cls, process: asyncio.subprocess.Process, identities: list[psutil.Process], timeout: float
    ) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while cls._still_running(process, identities) and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.02)

    @classmethod
    def _signal_owned(cls, worker: Worker, identities: list[psutil.Process], signum: int) -> None:
        identity = worker._identity
        if identity is not None and cls._alive(identity):
            try:
                if os.name != "nt" and os.getpgid(identity.pid) == identity.pid:
                    os.killpg(identity.pid, signum)
            except ProcessLookupError:
                pass
            except PermissionError:
                worker.cleanup_errors += 1
        for owned in reversed(identities):
            try:
                if cls._alive(owned):
                    owned.send_signal(signum)
            except psutil.NoSuchProcess:
                pass
            except psutil.AccessDenied:
                worker.cleanup_errors += 1

    async def aclose(self) -> None:
        """Stop all owned workers. Repeated calls wait for the same cleanup."""
        if self._closing is None:
            self._closed = True

            async def close_all() -> None:
                await asyncio.gather(*(self.stop(worker.id, "manager shutdown") for worker in self._workers.values()))

            self._closing = asyncio.create_task(close_all())
        await asyncio.shield(self._closing)

    async def __aenter__(self) -> ClaudeManager:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
