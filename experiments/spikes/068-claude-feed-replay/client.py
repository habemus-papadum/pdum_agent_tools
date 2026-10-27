"""SDK-free test client. Native interpretation lives here, never in server.py."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import uuid

from aiohttp import ClientSession, WSMsgType


class Client:
    def __init__(self, http: ClientSession, url: str):
        self.http, self.url = http, url
        self.events: list[dict] = []
        self.frames: list[dict] = []
        self.raw = b""
        self.buffer = b""
        self.changed = asyncio.Event()
        self.closed = False

    async def connect(self):
        self.ws = await self.http.ws_connect(self.url, max_msg_size=0)
        self.reader = asyncio.create_task(self._read())
        await self.until(lambda: any(e["kind"] == "replay-end" for e in self.events))
        return self

    async def _read(self):
        try:
            async for message in self.ws:
                if message.type != WSMsgType.TEXT:
                    continue
                event = json.loads(message.data)
                self.events.append(event)
                if event["kind"] == "output":
                    data = base64.b64decode(event["data"])
                    self.raw += data
                    self.buffer += data
                    while b"\n" in self.buffer:
                        line, self.buffer = self.buffer.split(b"\n", 1)
                        if line:
                            try:
                                self.frames.append(json.loads(line))
                            except json.JSONDecodeError:
                                self.frames.append({"parseError": True, "line": line.decode(errors="replace")})
                self.changed.set()
        finally:
            self.closed = True
            self.changed.set()

    async def until(self, predicate, timeout=30):
        async with asyncio.timeout(timeout):
            while not predicate():
                self.changed.clear()
                await self.changed.wait()

    async def send(self, frame):
        await self.ws.send_str(json.dumps(frame, separators=(",", ":")) + "\n")

    async def control(self, subtype, **kwargs):
        request_id = str(uuid.uuid4())
        await self.send(
            {"type": "control_request", "request_id": request_id, "request": {"subtype": subtype, **kwargs}}
        )
        await self.until(
            lambda: any(
                f.get("type") == "control_response" and f.get("response", {}).get("request_id") == request_id
                for f in self.frames
            )
        )
        return next(f for f in self.frames if f.get("response", {}).get("request_id") == request_id)

    async def user(self, text):
        identity = str(uuid.uuid4())
        await self.send(
            {
                "type": "user",
                "uuid": identity,
                "session_id": "",
                "parent_tool_use_id": None,
                "message": {"role": "user", "content": text},
            }
        )
        return identity

    async def close(self):
        await self.ws.close()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader
