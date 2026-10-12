"""Cooperative inspection of messages without coupling it to forwarding."""

from __future__ import annotations

import asyncio
import base64
import importlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib.metadata import entry_points
from pathlib import Path
from typing import Any, Protocol, TextIO


@dataclass(frozen=True)
class Observation:
    """An immutable message seen by the relay, not a delivery acknowledgment."""

    run_id: str
    connection_id: str
    seq: int
    direction: str
    payload: str | bytes
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    monotonic: float = field(default_factory=time.monotonic)
    byte_count: int = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "byte_count", len(self.payload.encode("utf-8") if isinstance(self.payload, str) else self.payload)
        )

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable record preserving text and binary payloads."""
        return {
            "schema": "pdum.codex_launcher.message/1",
            "run_id": self.run_id,
            "connection_id": self.connection_id,
            "seq": self.seq,
            "direction": self.direction,
            "timestamp": self.timestamp,
            "monotonic": self.monotonic,
            "encoding": "base64" if isinstance(self.payload, bytes) else "text",
            "payload": base64.b64encode(self.payload).decode() if isinstance(self.payload, bytes) else self.payload,
        }


class MessageProcessor(Protocol):
    """Async inspection hook; blocking I/O must be offloaded by the processor."""

    async def open(self) -> None:
        """Prepare the processor outside the forwarding path."""
        ...

    async def process(self, observation: Observation) -> None:
        """Consume one observation without changing the forwarded message."""
        ...

    async def close(self) -> None:
        """Flush and close processor-owned resources."""
        ...


class JsonlRecorder:
    """Write complete observations to a new file using off-loop filesystem I/O.

    Parameters
    ----------
    path
        New output file. Existing files are never overwritten.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._stream: TextIO | None = None

    async def open(self) -> None:
        """Create the output file, failing rather than overwriting evidence."""
        self._stream = await asyncio.to_thread(self._open_file)

    def _open_file(self) -> TextIO:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        return self.path.open("x", encoding="utf-8")

    async def process(self, observation: Observation) -> None:
        """Write and flush one observation off the event loop."""
        await asyncio.to_thread(self._write, observation)

    def _write(self, observation: Observation) -> None:
        if self._stream is None:
            raise RuntimeError("Recorder is not open")
        self._stream.write(json.dumps(observation.as_dict(), ensure_ascii=False) + "\n")
        self._stream.flush()

    async def close(self) -> None:
        """Close an opened output file."""
        if self._stream is not None:
            await asyncio.to_thread(self._stream.close)
            self._stream = None


def discover_processors() -> dict[str, str]:
    """List installed processor entry points without importing their factories."""
    return {entry.name: entry.value for entry in entry_points(group="pdum.codex_launcher.processors")}


def load_processor(reference: str, **configuration: Any) -> MessageProcessor:
    """Create an explicitly selected processor by entry-point name or factory reference."""
    target = discover_processors().get(reference, reference)
    module_name, separator, attribute = target.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError("Processor must be an installed name or module:factory reference")
    factory = getattr(importlib.import_module(module_name), attribute)
    return factory(**configuration)


@dataclass
class _ProcessorState:
    processor: MessageProcessor
    queue: asyncio.Queue[Observation] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    error: str | None = None
    accepted: int = 0
    processed: int = 0
    lost: int = 0
    pending_bytes: int = 0
    processing: Observation | None = None
    last_latency_seconds: float | None = None


class Observer:
    """Fan out to independent cooperative processors without admission quotas."""

    def __init__(self, processors: tuple[MessageProcessor, ...], close_timeout: float = 5) -> None:
        self._states = [_ProcessorState(processor) for processor in processors]
        self._close_timeout = close_timeout
        self._closed = False

    async def start(self) -> None:
        """Start asynchronous processors without waiting on their preparation."""
        for state in self._states:
            state.task = asyncio.create_task(self._run(state), name="relay-observer")

    def submit(self, observation: Observation) -> None:
        """Enqueue an immutable observation; never await parsing or export."""
        if self._closed:
            return
        for state in self._states:
            if state.error is not None:
                state.lost += 1
                continue
            state.accepted += 1
            state.pending_bytes += observation.byte_count
            state.queue.put_nowait(observation)

    async def _run(self, state: _ProcessorState) -> None:
        try:
            await state.processor.open()
            while True:
                observation = await state.queue.get()
                state.processing = observation
                try:
                    await state.processor.process(observation)
                    state.processed += 1
                    state.last_latency_seconds = time.monotonic() - observation.monotonic
                except BaseException:
                    state.lost += 1
                    raise
                finally:
                    state.pending_bytes -= observation.byte_count
                    state.processing = None
                    state.queue.task_done()
        except asyncio.CancelledError:
            if not self._closed:
                state.error = "Processor canceled unexpectedly"
            raise
        except Exception as error:
            state.error = f"{type(error).__name__}: {error}"
        finally:
            self._discard_pending(state)
            try:
                async with asyncio.timeout(self._close_timeout):
                    await state.processor.close()
            except Exception as error:
                state.error = state.error or f"Close failed: {type(error).__name__}: {error}"

    @staticmethod
    def _discard_pending(state: _ProcessorState) -> None:
        while not state.queue.empty():
            observation = state.queue.get_nowait()
            state.pending_bytes -= observation.byte_count
            state.lost += 1
            state.queue.task_done()

    def status(self) -> list[dict[str, Any]]:
        """Return counters and failure state without copying message payloads."""
        return [
            {
                "processor": type(state.processor).__name__,
                "accepted": state.accepted,
                "processed": state.processed,
                "pending": state.queue.qsize() + int(state.processing is not None),
                "pending_bytes": state.pending_bytes,
                "lost": state.lost,
                "error": state.error,
                "last_latency_seconds": state.last_latency_seconds,
            }
            for state in self._states
        ]

    async def aclose(self) -> None:
        """Drain within the shutdown deadline, accounting for unfinished observations."""
        if self._closed:
            return
        self._closed = True
        try:
            async with asyncio.timeout(self._close_timeout):
                await asyncio.gather(*(state.queue.join() for state in self._states))
        except TimeoutError:
            for state in self._states:
                if state.pending_bytes or state.processing is not None:
                    state.error = state.error or "Observer shutdown drain timed out"
        tasks = [state.task for state in self._states if state.task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
