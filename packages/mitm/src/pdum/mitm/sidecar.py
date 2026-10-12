"""Async process ownership and control for a managed interception sidecar."""

import asyncio
import json
import shutil
import sys
import tempfile
import uuid
from collections import deque
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from .config import ProcessorSpec, SidecarConfig
from .environment import ProxyConnection


class SidecarFailure(RuntimeError):
    """Fatal proxy process or control failure, distinct from capture degradation."""


class SidecarHandle:
    """An application-owned proxy process and its observation controls.

    Obtain a ready handle from :func:`open_sidecar`; do not construct directly.
    """

    def __init__(self, config: SidecarConfig, processors: Sequence[ProcessorSpec]):
        self.config = config
        self.processors = processors
        self.run_id = uuid.uuid4().hex
        self.capture_path = Path(config.capture_dir).resolve() / self.run_id if config.capture_dir else None
        self.connection: ProxyConnection
        self.process: asyncio.subprocess.Process | None = None
        self._temporary: Path | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._ready = asyncio.get_running_loop().create_future()
        self._failure = asyncio.get_running_loop().create_future()
        self._write_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []
        self._heartbeat: asyncio.Task | None = None
        self._close_task: asyncio.Task | None = None
        self._closing = False
        self._diagnostics: deque[str] = deque(maxlen=20)

    @property
    def pid(self) -> int:
        """Return the worker PID for diagnostics, not an ownership guarantee."""
        if self.process is None:
            raise RuntimeError("sidecar has not started")
        return self.process.pid

    async def _start(self) -> None:
        if self.config.work_dir is not None:
            Path(self.config.work_dir).mkdir(parents=True, exist_ok=True)
        self._temporary = Path(tempfile.mkdtemp(prefix="pdum-mitm-", dir=self.config.work_dir))
        self.process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "pdum.mitm._worker",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self._tasks = [
            asyncio.create_task(self._read_control()),
            asyncio.create_task(self._read_diagnostics()),
            asyncio.create_task(self._watch_process()),
        ]
        configuration = {
            "run_id": self.run_id,
            "confdir": str(self._temporary),
            "archive": str(self.capture_path) if self.capture_path else None,
            "recording": self.config.recording,
            "bind_host": self.config.bind_host,
            "port": self.config.port,
            "upstream_ca": str(Path(self.config.upstream_ca).resolve()) if self.config.upstream_ca else None,
            "ignore_hosts": list(self.config.ignore_hosts),
            "control_timeout": self.config.control_timeout,
            "shutdown_timeout": self.config.shutdown_timeout,
            "processors": [asdict(processor) for processor in self.processors],
        }
        await self._send(configuration)
        ready = await asyncio.wait_for(asyncio.shield(self._ready), self.config.startup_timeout)
        host = self.config.advertised_host or {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(
            self.config.bind_host, self.config.bind_host
        )
        url_host = f"[{host}]" if ":" in host else host
        self.connection = ProxyConnection(
            f"http://{url_host}:{ready['port']}", Path(ready["ca_cert_path"]), self.run_id
        )
        probe_host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(self.config.bind_host, self.config.bind_host)
        _, stream = await asyncio.wait_for(asyncio.open_connection(probe_host, ready["port"]), 3)
        stream.close()
        await stream.wait_closed()
        self._heartbeat = asyncio.create_task(self._monitor())

    def _failed(self, failure: SidecarFailure) -> None:
        if not self._ready.done():
            self._ready.set_exception(failure)
        if not self._failure.done() and not self._closing:
            self._failure.set_result(failure)
        for future in self._pending.values():
            if not future.done():
                future.set_exception(failure)

    async def _read_control(self) -> None:
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if message.get("ready"):
                    if not self._ready.done():
                        self._ready.set_result(message)
                elif "fatal" in message:
                    self._failed(SidecarFailure(message["fatal"]))
                elif "id" in message:
                    future = self._pending.get(message["id"])
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError(message["error"]))
                        else:
                            future.set_result(message["result"])
                else:
                    raise SidecarFailure("worker sent an unknown control response")
            if not self._closing:
                self._failed(SidecarFailure("proxy worker control channel closed unexpectedly"))
        except Exception as error:
            self._failed(SidecarFailure(f"worker control failed: {error}"))

    async def _read_diagnostics(self) -> None:
        while chunk := await self.process.stderr.read(4096):
            self._diagnostics.append(chunk.decode(errors="replace"))

    async def _watch_process(self) -> None:
        code = await self.process.wait()
        if not self._closing:
            self._failed(SidecarFailure(f"proxy worker exited with status {code}"))

    async def _monitor(self) -> None:
        try:
            while True:
                await asyncio.sleep(2)
                await self.status()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._failed(SidecarFailure(f"proxy heartbeat failed: {error}"))

    async def _send(self, value: dict) -> None:
        async with self._write_lock:
            self.process.stdin.write((json.dumps(value) + "\n").encode())
            await self.process.stdin.drain()

    async def _request(self, command: str, **parameters) -> dict:
        if self.process is None or self.process.returncode is not None:
            raise SidecarFailure("proxy worker is not running")
        self._next_id += 1
        request_id = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"id": request_id, "command": command, **parameters})
            return await asyncio.wait_for(future, self.config.control_timeout + 1)
        finally:
            self._pending.pop(request_id, None)

    async def status(self) -> dict:
        """Return process, capture, backlog and per-processor health counters."""
        return await self._request("status")

    async def configure_capture(self, enabled: bool, *, expected_revision: int | None = None) -> dict:
        """Enable or disable recording without reconnecting proxied clients.

        Parameters
        ----------
        enabled
            New recording state. Enabling requires ``capture_dir`` at launch.
        expected_revision
            Optional optimistic concurrency check; stale changes are rejected.

        Returns
        -------
        dict
            Applied revision, boundary sequence and effective recording state.
        """
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be a bool")
        return await self._request("configure", enabled=enabled, expected_revision=expected_revision)

    async def flush(self) -> dict:
        """Wait for admitted observations and report durability/loss watermarks."""
        return await self._request("flush")

    async def wait_failure(self) -> SidecarFailure | None:
        """Return a fatal failure, or ``None`` on normal sidecar closure."""
        return await asyncio.shield(self._failure)

    async def aclose(self) -> dict:
        """Stop, drain and reap the child once; return final observation status."""
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        try:
            return await asyncio.shield(self._close_task)
        except asyncio.CancelledError:
            await asyncio.shield(self._close_task)
            raise

    async def _close(self) -> dict:
        self._closing = True
        result = {"complete": False, "state": "closed"}
        if self._heartbeat is not None:
            self._heartbeat.cancel()
            await asyncio.gather(self._heartbeat, return_exceptions=True)
        try:
            if self.process is not None and self.process.returncode is None:
                try:
                    async with asyncio.timeout(self.config.shutdown_timeout + 1):
                        result = await self._request("close")
                        await self.process.wait()
                except (Exception, asyncio.CancelledError) as error:
                    result = {"complete": False, "error": f"shutdown did not flush: {type(error).__name__}"}
                    if self.process.returncode is None:
                        self.process.terminate()
                        try:
                            await asyncio.wait_for(self.process.wait(), 2)
                        except TimeoutError:
                            self.process.kill()
                            await self.process.wait()
        finally:
            if self.process is not None and self.process.stdin is not None:
                self.process.stdin.close()
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
            if self._temporary is not None:
                await asyncio.to_thread(shutil.rmtree, self._temporary, True)
            if not self._ready.done():
                self._ready.cancel()
            elif not self._ready.cancelled():
                self._ready.exception()
            if not self._failure.done():
                self._failure.set_result(None)
        return {"state": "closed", **result}


@asynccontextmanager
async def open_sidecar(
    config: SidecarConfig | None = None, *, processors: Sequence[ProcessorSpec] = ()
) -> AsyncIterator[SidecarHandle]:
    """Launch a ready proxy and guarantee bounded process cleanup on exit.

    Parameters
    ----------
    config
        Launch settings; omitted settings start an all-interface forwarding proxy
        with recording disabled. No global proxy or CA settings are modified.
    processors
        Explicit importable observation factories. They run only for recorded
        observations; discovery does not activate providers implicitly.

    Yields
    ------
    SidecarHandle
        Ready connection settings and runtime observation controls.
    """
    handle = SidecarHandle(config or SidecarConfig(), processors)
    try:
        await handle._start()
        yield handle
    finally:
        await handle.aclose()
