"""Independent, loss-accounted observers for the unmodified Claude byte stream."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class Observation:
    """One immutable byte chunk observed at the relay boundary."""

    worker_id: str
    direction: str
    payload: bytes
    sequence: int
    timestamp: float = field(default_factory=time.time)
    monotonic: float = field(default_factory=time.monotonic)


class Processor(Protocol):
    """Asynchronous inspection hook; offload blocking work from the event loop."""

    async def open(self) -> None:
        """Prepare processor resources."""
        ...

    async def process(self, observation: Observation) -> None:
        """Inspect a copy without affecting forwarding."""
        ...

    async def close(self) -> None:
        """Flush and release resources."""
        ...


@dataclass
class _State:
    processor: Processor
    queue: asyncio.Queue[Observation] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    accepted: int = 0
    processed: int = 0
    lost: int = 0
    pending_bytes: int = 0
    error: str | None = None
    lag_seconds: float = 0


class ObservationHub:
    """Fan out observations without awaiting processors or imposing admission caps.

    Parameters
    ----------
    processors
        Explicit processor instances, each with an independent queue.
    close_timeout
        Maximum drain time during shutdown; any unfinished records count as loss.
    """

    def __init__(self, processors: tuple[Processor, ...] = (), *, close_timeout: float = 5) -> None:
        self._states = [_State(processor) for processor in processors]
        self._sequence = 0
        self._closed = False
        self._started = False
        self._close_timeout = close_timeout

    async def start(self) -> None:
        """Schedule preparation and processing independently of the relay."""
        if self._started:
            return
        self._started = True
        for state in self._states:
            state.task = asyncio.create_task(self._run(state), name="claude-observation")

    def emit(self, worker_id: str, direction: str, payload: bytes) -> None:
        """Copy and enqueue bytes without parsing, writing or awaiting export."""
        self._sequence += 1
        observation = Observation(worker_id, direction, bytes(payload), self._sequence)
        for state in self._states:
            state.accepted += 1
            if self._closed or state.error:
                state.lost += 1
                continue
            state.pending_bytes += len(payload)
            state.queue.put_nowait(observation)

    async def _run(self, state: _State) -> None:
        try:
            await state.processor.open()
            while True:
                observation = await state.queue.get()
                try:
                    await state.processor.process(observation)
                    state.processed += 1
                    state.lag_seconds = time.monotonic() - observation.monotonic
                except BaseException:
                    state.lost += 1
                    raise
                finally:
                    state.pending_bytes -= len(observation.payload)
                    state.queue.task_done()
        except asyncio.CancelledError:
            if not self._closed:
                state.error = "Processor cancelled unexpectedly"
            raise
        except Exception as error:
            # Exception strings can contain payloads, file contents or credentials.
            state.error = type(error).__name__
        finally:
            while not state.queue.empty():
                observation = state.queue.get_nowait()
                state.pending_bytes -= len(observation.payload)
                state.lost += 1
                state.queue.task_done()
            try:
                async with asyncio.timeout(self._close_timeout):
                    await state.processor.close()
            except Exception as error:
                state.error = state.error or f"Close failed: {type(error).__name__}"

    def status(self) -> list[dict[str, Any]]:
        """Return backlog, actual losses and failures without message payloads."""
        return [
            {
                "processor": type(state.processor).__name__,
                "accepted": state.accepted,
                "processed": state.processed,
                "lost": state.lost,
                "pending_bytes": state.pending_bytes,
                "pending_records": state.accepted - state.processed - state.lost,
                "lag_seconds": state.lag_seconds,
                "error": state.error,
                "bytes_written": getattr(state.processor, "bytes_written", None),
                "storage_free_bytes": getattr(state.processor, "storage_free_bytes", None),
            }
            for state in self._states
        ]

    async def close(self) -> None:
        """Drain processors for a bounded time, then report unfinished records."""
        if self._closed:
            return
        self._closed = True
        try:
            async with asyncio.timeout(self._close_timeout):
                await asyncio.gather(*(state.queue.join() for state in self._states))
        except TimeoutError:
            for state in self._states:
                if state.pending_bytes:
                    state.error = state.error or "Drain timeout"
        finally:
            for state in self._states:
                if state.task:
                    state.task.cancel()
            await asyncio.gather(*(s.task for s in self._states if s.task), return_exceptions=True)


class JsonlRecorder:
    """Record complete chunks in a new file; never overwrite an existing capture."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._stream: Any = None
        self._lock = threading.Lock()
        self._closing = False
        self.bytes_written = 0
        self.storage_free_bytes: int | None = None

    async def open(self) -> None:
        """Create the capture with owner-only permissions."""
        await asyncio.to_thread(self._open)

    def _open(self) -> None:
        with self._lock:
            if self._closing:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            self._stream = os.fdopen(descriptor, "w", encoding="utf-8")

    async def process(self, observation: Observation) -> None:
        """Serialize and write the full payload off the forwarding event loop."""
        await asyncio.to_thread(self._write, observation)

    def _write(self, observation: Observation) -> None:
        data = (
            json.dumps(
                {
                    "schema": "pdum.claude_launcher.chunk/1",
                    "worker_id": observation.worker_id,
                    "direction": observation.direction,
                    "sequence": observation.sequence,
                    "timestamp": observation.timestamp,
                    "encoding": "base64",
                    "payload": base64.b64encode(observation.payload).decode("ascii"),
                }
            )
            + "\n"
        )
        with self._lock:
            if self._stream is None:
                raise RuntimeError("Recorder closed before write")
            self._stream.write(data)
            self._stream.flush()
            self.bytes_written += len(data.encode("utf-8"))
            self.storage_free_bytes = shutil.disk_usage(self.path.parent).free

    async def close(self) -> None:
        """Close the recorder off the event loop."""
        self._closing = True
        await asyncio.to_thread(self._close)

    def _close(self) -> None:
        with self._lock:
            if self._stream is not None:
                self._stream.close()
                self._stream = None


class UsageObserver:
    """Expose public result usage and deduplicated cumulative SDK cost estimates.

    Reported cost is an SDK estimate, not inspected subscription billing. A
    resumed conversation's first total can include earlier work. Missing final
    result data is unknown; this observer never substitutes zero for it.
    """

    def __init__(self) -> None:
        self._pending: dict[str, bytes] = {}
        self.results: dict[str, dict[str, Any]] = {}
        self.conversation_totals: dict[str, float] = {}
        self.parse_errors = 0

    async def open(self) -> None:
        """Prepare this in-memory observer."""

    async def process(self, observation: Observation) -> None:
        """Parse complete NDJSON lines on the independent observer task."""
        if observation.direction != "worker_to_client":
            return
        pending, frames, errors = await asyncio.to_thread(
            _decode_lines, self._pending.get(observation.worker_id, b""), observation.payload
        )
        self._pending[observation.worker_id] = pending
        self.parse_errors += errors
        for frame in frames:
            if not isinstance(frame, dict) or frame.get("type") != "result":
                continue
            session_id = frame.get("session_id")
            total = frame.get("total_cost_usd")
            if isinstance(session_id, str) and isinstance(total, (int, float)) and not isinstance(total, bool):
                self.conversation_totals[session_id] = max(total, self.conversation_totals.get(session_id, total))
            self.results[observation.worker_id] = {
                "conversation_id": session_id,
                "reported_cumulative_cost_usd": total,
                "usage": frame.get("usage"),
                "model_usage": frame.get("modelUsage"),
                "is_error": frame.get("is_error"),
            }

    def status(self) -> dict[str, Any]:
        """Return observed totals without claiming per-launch or invoice completeness."""
        return {
            "source": "public SDK result events; cumulative conversation estimates, not billing",
            "workers_with_results": self.results.copy(),
            "conversation_totals_usd": self.conversation_totals.copy(),
            "parse_errors": self.parse_errors,
            "missing_result_cost": "unknown",
        }

    async def close(self) -> None:
        """Account for any incomplete final protocol lines."""
        self.parse_errors += sum(bool(value.strip()) for value in self._pending.values())
        self._pending.clear()


def _decode_lines(pending: bytes, payload: bytes) -> tuple[bytes, list[Any], int]:
    """Decode observed chunks off-loop; forwarding never waits for parsing."""
    lines = (pending + payload).split(b"\n")
    trailing = lines.pop()
    frames = []
    errors = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            frames.append(json.loads(line))
        except (ValueError, UnicodeError):
            errors += 1
    return trailing, frames, errors
