"""Small explicit observation processors, independent of model providers."""

import asyncio
import importlib
import json
import os
from collections.abc import Mapping
from importlib.metadata import entry_points
from pathlib import Path
from typing import Any, Protocol


class Processor(Protocol):
    """An async inspection-only receiver running away from traffic callbacks."""

    async def process(self, record: Mapping[str, Any]) -> None:
        """Consume a recursively immutable captured record."""
        ...

    async def flush(self) -> None:
        """Finish delivery of previously processed observations."""
        ...

    async def aclose(self) -> None:
        """Release processor resources after the final flush."""
        ...


def mutable_record(value: Any) -> Any:
    """Convert immutable observation containers into JSON-compatible values."""
    if isinstance(value, Mapping):
        return {key: mutable_record(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [mutable_record(item) for item in value]
    return value


class JsonlProcessor:
    """Write observations to a new JSONL file without overwriting existing data.

    Parameters
    ----------
    path
        Exact output path. Parent directories may already exist.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._stream = None
        self.bytes_written = 0
        self.written_seq = 0
        self.persisted_seq = 0

    def _write(self, encoded: str) -> None:
        if self._stream is None:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            self._stream = os.fdopen(descriptor, "w", encoding="utf-8")
        self._stream.write(encoded)
        self.bytes_written += len(encoded.encode("utf-8"))

    async def process(self, record: Mapping[str, Any]) -> None:
        encoded = json.dumps(mutable_record(record), ensure_ascii=True, separators=(",", ":")) + "\n"
        await asyncio.to_thread(self._write, encoded)
        self.written_seq = int(record["seq"])

    async def flush(self) -> None:
        if self._stream is not None:
            await asyncio.to_thread(self._stream.flush)
            await asyncio.to_thread(os.fsync, self._stream.fileno())
            self.persisted_seq = self.written_seq

    async def aclose(self) -> None:
        if self._stream is not None:
            await asyncio.to_thread(self._stream.close)
            self._stream = None


def load_factory(reference: str):
    """Resolve one explicitly selected ``module:attribute`` factory."""
    module, separator, attribute = reference.partition(":")
    if not separator or not module or not attribute:
        raise ValueError("processor factory must use module:attribute syntax")
    return getattr(importlib.import_module(module), attribute)


def discover_processors() -> dict[str, str]:
    """List installed factory references without importing or activating them."""
    discovered: dict[str, str] = {}
    for entry in entry_points(group="pdum.mitm.processors"):
        if entry.name in discovered:
            raise ValueError(f"duplicate processor name: {entry.name}")
        discovered[entry.name] = entry.value
    return discovered
