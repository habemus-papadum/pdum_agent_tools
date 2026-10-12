"""Read-only Codex usage snapshots suitable for application-owned exporters."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from typing import Any

from .observation import Observation


class UsageObserver:
    """Keep the latest native usage snapshot per thread, never sum repeated totals.

    Notes
    -----
    Missing fields stay absent. This observer does not infer cost or context left
    from a model name, and it never issues requests to the app-server.
    """

    def __init__(self) -> None:
        self._latest: dict[str, dict[str, Any]] = {}

    async def open(self) -> None:
        """Prepare this in-memory observer without external services."""

    async def process(self, observation: Observation) -> None:
        """Inspect native usage notifications off the forwarding event loop."""
        if observation.direction != "server_to_client":
            return
        try:
            message = await asyncio.to_thread(json.loads, observation.payload)
        except (ValueError, UnicodeError):
            return
        if not isinstance(message, dict) or message.get("method") != "thread/tokenUsage/updated":
            return
        params = message.get("params")
        if not isinstance(params, dict):
            return
        thread_id = params.get("threadId")
        usage = params.get("tokenUsage")
        if not isinstance(thread_id, str) or not isinstance(usage, dict):
            return
        self._latest[thread_id] = {
            "run_id": observation.run_id,
            "connection_id": observation.connection_id,
            "source_seq": observation.seq,
            "timestamp": observation.timestamp,
            "thread_id": thread_id,
            "turn_id": params.get("turnId"),
            "token_usage": usage,
        }

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """Return independent snapshots preserving native total/last semantics."""
        return deepcopy(self._latest)

    async def close(self) -> None:
        """Retain snapshots for the owner to inspect after shutdown."""
