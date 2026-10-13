"""Transparent UTF-8 stream transport for client-owned official Claude SDK queries."""

from __future__ import annotations

import asyncio
import codecs
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .runtime import ClaudeManager, Close, Receive, Send, Worker


async def bridge_worker(
    manager: ClaudeManager, worker_id: str, receive: Receive, send: Send, close: Close | None = None
) -> None:
    """Forward chunks without inspecting JSON or owning SDK callbacks.

    A transport EOF ends the worker. UTF-8 decoding buffers only incomplete code
    points, never waits for a complete NDJSON line, and never changes JSON bytes.
    """
    worker = manager.worker(worker_id)
    tasks: list[asyncio.Task[None]] = []
    claimed = False
    try:
        # Claims happen before the first await inside _attach, under its lock.
        await manager._attach(worker_id, close)
        claimed = True
        tasks = [
            asyncio.create_task(_to_process(manager, worker, receive)),
            asyncio.create_task(_to_client(manager, worker, send)),
        ]
        tasks.append(asyncio.create_task(_watch_exit(manager, worker, tasks[1])))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        worker.reason = worker.reason or ("client disconnected" if tasks[0] in done else "worker output closed")
    except (ConnectionClosed, BrokenPipeError, ConnectionResetError):
        worker.reason = worker.reason or "client disconnected"
    except asyncio.CancelledError:
        if worker._stop is None:
            raise
    except Exception:
        if worker._bridge is asyncio.current_task():
            worker.transport_errors += 1
            worker.reason = worker.reason or "worker transport failed"
        raise
    finally:
        # A rejected second controller must never clean up the original one.
        if claimed or worker._bridge is asyncio.current_task():
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await manager.stop(worker_id, "controller ended")


async def _to_process(manager: ClaudeManager, worker: Worker, receive: Receive) -> None:
    assert worker._process is not None and worker._process.stdin is not None
    stdin = worker._process.stdin
    while (payload := await receive()) is not None:
        data = payload.encode("utf-8") if isinstance(payload, str) else payload
        stdin.write(data)
        worker.input_bytes += len(data)
        manager.observe(worker, "client_to_worker", data)
        await stdin.drain()


async def _to_client(manager: ClaudeManager, worker: Worker, send: Send) -> None:
    assert worker._process is not None and worker._process.stdout is not None
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    while data := await worker._process.stdout.read(65536):
        text = decoder.decode(data)
        worker.output_bytes += len(data)
        manager.observe(worker, "worker_to_client", data)
        if text:
            await send(text)
    tail = decoder.decode(b"", final=True)
    if tail:
        await send(tail)


async def _watch_exit(manager: ClaudeManager, worker: Worker, output: asyncio.Task[None]) -> None:
    assert worker._process is not None
    # Process.wait() can itself wait for inherited pipes after the native PID
    # exits. Check the child-watcher's return code independently of those pipes.
    while worker._process.returncode is None:
        await asyncio.sleep(0.1)
    done, _ = await asyncio.wait({output}, timeout=manager._stop_timeout)
    if not done:
        worker.cleanup_errors += 1
        worker.reason = worker.reason or "worker exited while output remained open"
        manager._close_owned_pipes(worker)


class Relay:
    """Optional standalone WebSocket listener around the same manager bridge."""

    def __init__(self, manager: ClaudeManager, *, close_timeout: float = 3.0) -> None:
        self.manager = manager
        self.close_timeout = close_timeout
        self.endpoint = ""
        self.bind_endpoint = ""
        self._server: Server | None = None

    async def start(self, host: str = "0.0.0.0", port: int = 0) -> None:
        """Bind a browser-compatible trusted-network listener."""
        self._server = await serve(
            self._handle,
            host,
            port,
            origins=None,
            max_size=None,
            max_queue=None,
            close_timeout=self.close_timeout,
        )
        actual_port = self._server.sockets[0].getsockname()[1]
        connect_host = "127.0.0.1" if host == "0.0.0.0" else "::1" if host == "::" else host
        self.endpoint = self._url(connect_host, actual_port)
        self.bind_endpoint = self._url(host, actual_port)

    @staticmethod
    def _url(host: str, port: int) -> str:
        return f"ws://[{host}]:{port}" if ":" in host else f"ws://{host}:{port}"

    def worker_url(self, worker_id: str) -> str:
        """Return the endpoint for an allocated controller lifetime."""
        self.manager.worker(worker_id)
        return f"{self.endpoint}/workers/{worker_id}"

    async def _handle(self, socket: ServerConnection) -> None:
        path = socket.request.path if socket.request else ""
        parts = path.split("?")[0].strip("/").split("/")
        if len(parts) != 2 or parts[0] != "workers":
            await socket.close(1008, "Unknown worker endpoint")
            return
        try:
            await self.manager.bridge(parts[1], socket.recv, socket.send, socket.close)
        except KeyError:
            await socket.close(1008, "Unknown worker")
        except RuntimeError:
            await socket.close(1008, "Worker already claimed or stopped")
        except Exception:
            await socket.close(1011, "Worker transport failed")

    async def aclose(self) -> None:
        """Close attached clients and their workers; the manager remains reusable."""
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None


@asynccontextmanager
async def open_relay(
    manager: ClaudeManager, *, host: str = "0.0.0.0", port: int = 0, close_timeout: float = 3.0
) -> AsyncIterator[Relay]:
    """Bind a standalone relay; HTTP management adapters can instead use ``bridge``."""
    relay = Relay(manager, close_timeout=close_timeout)
    await relay.start(host, port)
    try:
        yield relay
    finally:
        await relay.aclose()
