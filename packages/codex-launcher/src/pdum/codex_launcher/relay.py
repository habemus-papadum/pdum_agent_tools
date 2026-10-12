"""A transparent WebSocket relay with an independent inspection stream."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from websockets.asyncio.client import connect, unix_connect
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .observation import MessageProcessor, Observation, Observer


class Relay:
    """One upstream connection per client, with no application protocol rewriting."""

    def __init__(
        self,
        upstream_url: str,
        *,
        processors: Iterable[MessageProcessor] = (),
        upstream_headers: Mapping[str, str] | None = None,
        close_timeout: float = 5,
    ) -> None:
        self.upstream_url = upstream_url
        self.run_id = uuid4().hex
        self.endpoint = ""
        self.bind_endpoint = ""
        self._headers = upstream_headers
        self._observer = Observer(tuple(processors), close_timeout)
        self._server: Server | None = None
        self._seq = 0
        self._connections = 0
        self._total_connections = 0
        self._errors = 0
        self._closed = False
        self._close_timeout = close_timeout

    async def start(self, host: str, port: int) -> None:
        """Bind a listener, allowing ordinary browser Origin headers."""
        if not self.upstream_url.startswith(("ws://", "wss://", "unix://")):
            raise ValueError("Upstream must be a ws://, wss:// or unix:// endpoint")
        await self._observer.start()
        try:
            self._server = await serve(
                self._handle,
                host,
                port,
                max_size=None,
                origins=None,
                close_timeout=self._close_timeout,
            )
        except BaseException:
            await self._observer.aclose()
            raise
        actual_port = self._server.sockets[0].getsockname()[1]
        connect_host = "127.0.0.1" if host == "0.0.0.0" else "::1" if host == "::" else host
        self.endpoint = self._url(connect_host, actual_port)
        self.bind_endpoint = self._url(host, actual_port)

    @staticmethod
    def _url(host: str, port: int) -> str:
        return f"ws://[{host}]:{port}" if ":" in host else f"ws://{host}:{port}"

    def _upstream(self) -> connect:
        options: dict[str, Any] = {
            "max_size": None,
            "proxy": None,
            "additional_headers": self._headers,
            "close_timeout": self._close_timeout,
        }
        if self.upstream_url.startswith("unix://"):
            return unix_connect(self.upstream_url.removeprefix("unix://"), **options)
        return connect(self.upstream_url, **options)

    async def _handle(self, downstream: ServerConnection) -> None:
        connection_id = uuid4().hex
        self._connections += 1
        self._total_connections += 1
        try:
            async with self._upstream() as upstream:
                tasks = [
                    asyncio.create_task(self._pipe(downstream, upstream, connection_id, "client_to_server")),
                    asyncio.create_task(self._pipe(upstream, downstream, connection_id, "server_to_client")),
                ]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    self._errors += sum(isinstance(result, Exception) for result in results)
        except ConnectionClosed:
            pass
        except Exception:
            self._errors += 1
            await downstream.close(code=1011, reason="Upstream connection failed")
        finally:
            self._connections -= 1

    async def _pipe(self, source: Any, destination: Any, connection_id: str, direction: str) -> None:
        try:
            async for payload in source:
                self._seq += 1
                self._observer.submit(Observation(self.run_id, connection_id, self._seq, direction, payload))
                if len(payload) > 65536:
                    await destination.send(payload[offset : offset + 65536] for offset in range(0, len(payload), 65536))
                else:
                    await destination.send(payload)
        except ConnectionClosed:
            pass
        finally:
            received_code = source.close_code
            valid_codes = {1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014}
            code = (
                received_code
                if received_code in valid_codes or received_code and 3000 <= received_code < 5000
                else 1011
            )
            await destination.close(code=code, reason=source.close_reason or "Relay peer closed")

    async def status(self) -> dict[str, Any]:
        """Return transport and observer health without exposing payloads."""
        return {
            "run_id": self.run_id,
            "endpoint": self.endpoint,
            "bind_endpoint": self.bind_endpoint,
            "upstream": self.upstream_url,
            "connections": self._connections,
            "total_connections": self._total_connections,
            "messages": self._seq,
            "transport_errors": self._errors,
            "closed": self._closed,
            "processors": self._observer.status(),
        }

    async def aclose(self) -> None:
        """Stop clients, then drain observers without stopping their upstream owner."""
        if self._closed:
            return
        self._closed = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        await self._observer.aclose()


@asynccontextmanager
async def open_relay(
    upstream_url: str,
    *,
    host: str = "0.0.0.0",
    port: int = 0,
    processors: Iterable[MessageProcessor] = (),
    upstream_headers: Mapping[str, str] | None = None,
    close_timeout: float = 5,
) -> AsyncIterator[Relay]:
    """Open a browser-compatible relay and close it when the context exits.

    Parameters
    ----------
    upstream_url
        Native WebSocket or WebSocket-over-Unix endpoint.
    host, port
        Frontend bind address. Port zero selects an available port atomically.
    processors
        Explicit cooperative observation processors, independent of forwarding.
    upstream_headers
        Explicit backend handshake headers; browser headers are not copied.
    close_timeout
        Transport and observer shutdown timeout in seconds.
    """
    relay = Relay(upstream_url, processors=processors, upstream_headers=upstream_headers, close_timeout=close_timeout)
    await relay.start(host, port)
    try:
        yield relay
    finally:
        await relay.aclose()
