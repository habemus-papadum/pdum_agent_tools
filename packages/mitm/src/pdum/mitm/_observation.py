"""Cooperative processor dispatch on a separate thread and asyncio loop."""

import asyncio
import base64
import concurrent.futures
import json
import os
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .processors import JsonlProcessor, load_factory


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


class _ArchiveProcessor(JsonlProcessor):
    def __init__(self, archive: Path, run_id: str):
        super().__init__(archive / "records.jsonl")
        self.archive = archive
        self.run_id = run_id

    def _write(self, encoded: str) -> None:
        if self._stream is None:
            self.archive.mkdir(parents=True, exist_ok=False, mode=0o700)
            descriptor = os.open(self.archive / "manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"schema": "pdum.mitm.capture/1", "run_id": self.run_id, "complete": False}, stream)
                stream.flush()
                os.fsync(stream.fileno())
        super()._write(encoded)


class Observer:
    def __init__(self, archive: Path | None, run_id: str, specifications: list[dict]):
        self.archive = archive
        self.run_id = run_id
        self.specifications = specifications
        self.ready: concurrent.futures.Future = concurrent.futures.Future()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread = threading.Thread(target=self._thread_main, name="pdum-mitm-observer", daemon=True)
        self.queues: dict[str, asyncio.Queue] = {}
        self.processors: dict[str, Any] = {}
        self.tasks: list[asyncio.Task] = []
        self.health: dict[str, dict] = {}
        self.sequence = 0
        self.pending = 0
        self.pending_bytes = 0
        self._closed = False
        self.thread.start()

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._main())
        except BaseException as error:
            if not self.ready.done():
                self.ready.set_exception(error)

    async def _main(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.stopped = asyncio.Event()
        if self.archive is not None:
            self.processors["archive"] = _ArchiveProcessor(self.archive, self.run_id)
        for index, specification in enumerate(self.specifications):
            name = specification.get("name") or f"processor-{index}"
            if name in self.processors:
                raise ValueError(f"duplicate processor name: {name}")
            self.processors[name] = load_factory(specification["factory"])(**specification.get("config", {}))
        for name, processor in self.processors.items():
            self.queues[name] = asyncio.Queue()
            self.health[name] = {"pending": 0, "processed": 0, "lost": 0, "error": None, "last_latency_seconds": 0.0}
            self.tasks.append(asyncio.create_task(self._consume(name, processor)))
        self.ready.set_result(None)
        await self.stopped.wait()

    async def _consume(self, name: str, processor: Any) -> None:
        queue = self.queues[name]
        health = self.health[name]
        while True:
            record = await queue.get()
            if record is None:
                return
            if isinstance(record, asyncio.Future):
                try:
                    if health["error"] is None:
                        await processor.flush()
                except (Exception, asyncio.CancelledError) as error:
                    health["error"] = f"{type(error).__name__}: {error}"
                if not record.done():
                    record.set_result(None)
                continue
            try:
                if health["error"] is None:
                    started = time.monotonic()
                    await processor.process(record)
                    health["last_latency_seconds"] = time.monotonic() - started
                    health["processed"] += 1
                else:
                    health["lost"] += 1
            except (Exception, asyncio.CancelledError) as error:
                health["error"] = f"{type(error).__name__}: {error}"
                health["lost"] += 1
            finally:
                health["pending"] -= 1

    def submit(self, record: dict, payload: bytes | None = None) -> None:
        self.pending += 1
        self.pending_bytes += len(payload or b"")
        self.loop.call_soon_threadsafe(self._deliver, record, payload)

    def _deliver(self, record: dict, payload: bytes | None) -> None:
        try:
            if payload is not None:
                record["data_base64"] = base64.b64encode(payload).decode("ascii")
                record["bytes"] = len(payload)
                if record["kind"] == "websocket_message":
                    try:
                        record["text"] = payload.decode("utf-8")
                        try:
                            record["json"] = json.loads(record["text"])
                        except ValueError:
                            pass
                    except UnicodeDecodeError:
                        pass
            observation = _freeze(record)
            self.sequence = record["seq"]
            for name, queue in self.queues.items():
                self.health[name]["pending"] += 1
                queue.put_nowait(observation)
        finally:
            self.pending -= 1
            self.pending_bytes -= len(payload or b"")

    def status(self) -> dict:
        archive = self.processors.get("archive")
        return {
            "observation_backlog": self.pending,
            "observation_backlog_bytes": self.pending_bytes,
            "processors": {name: dict(health) for name, health in self.health.items()},
            "written_through_seq": archive.written_seq if archive else None,
            "persisted_through_seq": archive.persisted_seq if archive else None,
            "bytes_written": archive.bytes_written if archive else 0,
        }

    async def _flush(self) -> dict:
        target_sequence = self.sequence
        barriers = []
        for queue in self.queues.values():
            barrier = asyncio.get_running_loop().create_future()
            queue.put_nowait(barrier)
            barriers.append(barrier)
        await asyncio.gather(*barriers)
        status = self.status()
        losses = sum(health["lost"] for health in self.health.values())
        complete = not losses and all(health["error"] is None for health in self.health.values())
        return {"through_seq": target_sequence, "losses": losses, "complete": complete, **status}

    async def flush(self, timeout: float) -> dict:
        future = asyncio.run_coroutine_threadsafe(self._flush(), self.loop)
        return await asyncio.wait_for(asyncio.wrap_future(future), timeout)

    async def _close(self) -> dict:
        result = await self._flush()
        for name, processor in self.processors.items():
            try:
                await processor.aclose()
            except (Exception, asyncio.CancelledError) as error:
                self.health[name]["error"] = f"{type(error).__name__}: {error}"
                result["complete"] = False
        for queue in self.queues.values():
            queue.put_nowait(None)
        await asyncio.gather(*self.tasks)
        if self.archive is not None and self.archive.exists():
            await asyncio.to_thread(self._manifest, result)
        self.stopped.set()
        return result

    def _manifest(self, result: dict) -> None:
        content = {
            "schema": "pdum.mitm.capture/1",
            "run_id": self.run_id,
            "scope": "admitted observations only; recording-off intervals are omitted",
            "segments": ["records.jsonl"],
            **result,
        }
        path = self.archive / "manifest.json.tmp"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(content, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        path.replace(self.archive / "manifest.json")

    async def close(self, timeout: float) -> dict:
        if self._closed:
            return self.status()
        self._closed = True
        future = asyncio.run_coroutine_threadsafe(self._close(), self.loop)
        return await asyncio.wait_for(asyncio.wrap_future(future), timeout)
