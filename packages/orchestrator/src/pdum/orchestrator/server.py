"""Foreground HTTP hosting with pre-bound ephemeral ports and explicit ownership."""

from __future__ import annotations

import asyncio
import socket
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from .management import create_app
from .runtime import API_VERSION, Coordinator


@dataclass
class RunningServer:
    """Actual bound listener and its application-owned completion task."""

    coordinator: Coordinator
    url: str
    bound_host: str
    port: int
    _task: asyncio.Task[None]

    def readiness(self) -> dict[str, Any]:
        """Return one machine-readable readiness record after HTTP startup."""
        status = self.coordinator.status()
        return {
            "type": "orchestrator-ready",
            "apiVersion": API_VERSION,
            "instanceId": status["instanceId"],
            "url": self.url,
            "boundHost": self.bound_host,
            "pid": status["pid"],
            "processStartedAt": status["processStartedAt"],
            "stateDirectory": status["stateDirectory"],
            "workspaceDirectory": status["workspaceDirectory"],
        }

    async def wait(self) -> None:
        """Wait for listener shutdown, including an HTTP stop request."""
        await asyncio.shield(self._task)


@asynccontextmanager
async def open_server(
    coordinator: Coordinator,
    *,
    host: str = "0.0.0.0",
    port: int = 0,
) -> AsyncIterator[RunningServer]:
    """Serve an existing owner, without installing signal handlers.

    Parameters
    ----------
    coordinator
        Started application-owned coordinator. The caller closes it separately.
    host, port
        Bind address and port. Zero binds an available port in one operation.

    Yields
    ------
    RunningServer
        Actual endpoint and readiness metadata. A wildcard bind reports a local
        loopback URL for a local supervisor; ``boundHost`` retains the real bind.
    """
    try:
        import uvicorn
    except ImportError:
        raise RuntimeError("Install habemus-papadum-orchestrator[management] to serve HTTP") from None
    if coordinator.status()["state"] != "running":
        raise RuntimeError("HTTP serving requires a running coordinator")

    class OwnedServer(uvicorn.Server):
        @contextmanager
        def capture_signals(self):
            # The CLI/application entry point owns signal handlers, not a library.
            yield

    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    task: asyncio.Task[None] | None = None
    monitor: asyncio.Task[None] | None = None
    server = OwnedServer(uvicorn.Config(create_app(coordinator), log_level="warning", access_log=False))
    listener = socket.socket(family, socket.SOCK_STREAM)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((host, port))
        listener.listen(socket.SOMAXCONN)
        listener.setblocking(False)
        bound_port = listener.getsockname()[1]
        task = asyncio.create_task(server.serve(sockets=[listener]))

        async def stop_on_request() -> None:
            await coordinator.wait_for_stop()
            server.should_exit = True

        monitor = asyncio.create_task(stop_on_request())
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("Coordinator HTTP server ended before readiness")
                await asyncio.sleep(0.01)
        advertised = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
        if ":" in advertised:
            advertised = f"[{advertised}]"
        yield RunningServer(coordinator, f"http://{advertised}:{bound_port}", host, bound_port, task)
    finally:
        try:
            server.should_exit = True
            if monitor is not None:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            if task is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(task), 5)
                except TimeoutError:
                    server.force_exit = True
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    raise RuntimeError("Coordinator HTTP shutdown did not complete within five seconds") from None
        finally:
            listener.close()
