"""Minimal app-server JSON-RPC client with per-call timing, adapted from spike 028.

It speaks WebSocket over a Unix socket (``unix://``) or TCP (``ws://``), records every
request's latency and keeps notifications in arrival order for the live ingester.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from websockets.asyncio.client import connect, unix_connect


class RpcError(RuntimeError):
    pass


class Client:
    def __init__(self, name: str = "spike035") -> None:
        self.name = name
        self.notifications: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []
        self.pending: dict[str, asyncio.Future] = {}
        self.counter = 0
        self.socket: Any = None
        self.reader: asyncio.Task | None = None
        self.server_info: dict[str, Any] = {}

    async def open(self, endpoint: str, *, experimental: bool = True, timeout: float = 20) -> Client:
        if endpoint.startswith("unix://"):
            self.socket = await unix_connect(
                endpoint.removeprefix("unix://"), max_size=None, proxy=None, open_timeout=timeout
            )
        else:
            self.socket = await connect(endpoint, max_size=None, proxy=None, open_timeout=timeout)
        self.reader = asyncio.create_task(self._read())
        self.server_info = await self.request(
            "initialize",
            {"clientInfo": {"name": self.name, "version": "0.0.0"}, "capabilities": {"experimentalApi": experimental}},
        )
        await self.socket.send(json.dumps({"method": "initialized", "params": {}}))
        return self

    async def _read(self) -> None:
        try:
            async for payload in self.socket:
                message = json.loads(payload)
                if "id" in message and "method" not in message:
                    future = self.pending.pop(str(message["id"]), None)
                    if future and not future.done():
                        future.set_result(message)
                elif "method" in message and "id" in message:
                    # Server-initiated request (approval and similar); the spike never approves anything.
                    self.notifications.append({"received_at": time.time(), "server_request": True, **message})
                else:
                    self.notifications.append({"received_at": time.time(), **message})
        except Exception as error:  # noqa: BLE001
            self.notifications.append(
                {"received_at": time.time(), "method": "__transport__", "params": {"error": type(error).__name__}}
            )
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("client connection ended"))

    async def request(self, method: str, params: dict | None = None, *, timeout: float = 60) -> Any:
        self.counter += 1
        identifier = f"{self.name}:{self.counter}"
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        started = time.perf_counter()
        call = {
            "method": method,
            "params_summary": summarize(params),
            "started_at": datetime.now(UTC).replace(tzinfo=None),
        }
        await self.socket.send(json.dumps({"id": identifier, "method": method, "params": params or {}}))
        try:
            message = await asyncio.wait_for(future, timeout)
        except Exception as error:
            call.update(
                ms=(time.perf_counter() - started) * 1000, ok=False, result_rows=None, error=type(error).__name__
            )
            self.calls.append(call)
            raise
        call["ms"] = (time.perf_counter() - started) * 1000
        if "error" in message:
            call.update(ok=False, result_rows=None, error=json.dumps(message["error"])[:500])
            self.calls.append(call)
            raise RpcError(f"{method}: {message['error']}")
        result = message.get("result")
        rows = len(result["data"]) if isinstance(result, dict) and isinstance(result.get("data"), list) else None
        call.update(ok=True, result_rows=rows, error=None)
        self.calls.append(call)
        return result

    async def wait(
        self, method: str, *, after: int = 0, timeout: float = 120, predicate: Callable[[dict], bool] = lambda _: True
    ) -> dict:
        async with asyncio.timeout(timeout):
            while True:
                for message in self.notifications[after:]:
                    if message.get("method") == method and predicate(message):
                        return message
                await asyncio.sleep(0.02)

    async def close(self) -> None:
        if self.socket is not None:
            await self.socket.close()
        if self.reader is not None:
            await self.reader


def summarize(params: dict | None) -> str:
    if not params:
        return ""
    keep = {
        k: (v if isinstance(v, (int, float, bool)) or (isinstance(v, str) and len(v) <= 48) else "…")
        for k, v in params.items()
    }
    return json.dumps(keep)[:300]
