"""Explicit test processors exercising cooperative extension failure behavior."""

import asyncio


class CancelledProcessor:
    def __init__(self, method="process"):
        self.method = method

    async def process(self, record):
        if self.method == "process":
            raise asyncio.CancelledError("processor stopped its own observation")

    async def flush(self):
        if self.method == "flush":
            raise asyncio.CancelledError("processor stopped its own flush")

    async def aclose(self):
        pass


class SlowFlushProcessor:
    async def process(self, record):
        pass

    async def flush(self):
        await asyncio.sleep(0.5)

    async def aclose(self):
        pass
