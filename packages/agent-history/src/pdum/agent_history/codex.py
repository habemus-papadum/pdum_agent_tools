"""Read a Codex home into the shared DuckDB schema without writing to the home.

Inputs are the thread catalogue (``state_5.sqlite``), the history projection
(``thread_history_1.sqlite``), the log database (``logs_2.sqlite``) and every rollout file under
``sessions/`` and ``archived_sessions/``. Rollouts are the record: they alone hold per-response
usage, rate limits, turn settings and fork lineage. Threads older than the support window are
listed in ``coverage`` with ``in_window = false`` and otherwise skipped.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import items as item_columns
from . import schema
from .base import DEFAULT_WINDOW_DAYS, BaseIngest, IngestSummary, compact, repo_from_origin
from .sqlite import open_readonly

SOURCE = "codex-fs"
__all__ = ["DEFAULT_WINDOW_DAYS", "CodexIngest", "IngestSummary", "compact", "default_codex_home", "ingest_codex_home"]

LEGACY_ITEM_TYPES = {
    "message",
    "function_call",
    "function_call_output",
    "reasoning",
    "local_shell_call",
    "custom_tool_call",
    "custom_tool_call_output",
    "web_search_call",
}
PASSTHROUGH_EVENTS = {
    "world_state",
    "inter_agent_communication",
    "inter_agent_communication_metadata",
    "realtime_item",
    "session_meta",
}


def default_codex_home() -> Path:
    """Return ``$CODEX_HOME`` or ``~/.codex``."""
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()


def _usage_fields(prefix: str, usage: dict[str, Any] | None, keys: tuple[str, ...] | None = None) -> dict[str, Any]:
    usage = usage or {}
    names = keys or (
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    )
    return {f"{prefix}{name}": usage.get(name) for name in names}


class CodexIngest(BaseIngest):
    """One ingest of a Codex home into a fresh DuckDB file.

    Parameters
    ----------
    home : Path
        Codex home to read.
    db_path : Path
        DuckDB file to create; an existing file is replaced.
    window_days : int or None
        Threads created before ``now - window_days`` are counted, not modelled. None disables.
    blobs : bool
        Store full item JSON in ``item_blobs``.
    now : datetime or None
        Reference time for the window; defaults to the current UTC time.
    """

    def __init__(
        self,
        home: Path,
        db_path: Path,
        *,
        window_days: int | None = DEFAULT_WINDOW_DAYS,
        blobs: bool = True,
        now: datetime | None = None,
    ) -> None:
        super().__init__(SOURCE, "codex", home, db_path, window_days=window_days, blobs=blobs, now=now)
        self.home = self.root
        self.threads: dict[str, dict[str, Any]] = {}
        self.turns: dict[tuple[str, str], dict[str, Any]] = {}

    # ----------------------------------------------------------------- ingest
    def ingest(self) -> None:
        """Read the catalogue, every rollout, the projection and the logs."""
        self.catalogue()
        self.rollouts()
        self.projection()
        self.logs()
        self.finish()

    # -------------------------------------------------------------- catalogue
    def catalogue(self) -> None:
        assert self.con is not None
        started = time.perf_counter()
        path = self.home / "state_5.sqlite"
        if not path.exists():
            self.summary.notes.append("state_5.sqlite absent")
            self.phase("catalogue", started, 0, "absent")
            return
        connection, how = open_readonly(path)
        connection.row_factory = sqlite3.Row
        count = 0
        for record in connection.execute("select * from threads"):
            source = record["source"] or ""
            source_kind = source
            if source.startswith("{"):
                try:
                    parsed = json.loads(source)
                    source_kind = next(iter(parsed)) if isinstance(parsed, dict) and parsed else source[:32]
                except ValueError:
                    source_kind = source[:32]
            created = schema.from_ms(record["created_at_ms"] or record["created_at"])
            self.threads[record["id"]] = {
                "thread_id": record["id"],
                "created_at": created,
                "updated_at": schema.from_ms(record["updated_at_ms"] or record["updated_at"]),
                "source_kind": source_kind,
                "thread_source": record["thread_source"],
                "originator": record["originator"],
                "cli_version": record["cli_version"],
                "model_provider": record["model_provider"],
                "repo": repo_from_origin(record["git_origin_url"]),
                "cwd": record["cwd"],
                "git_branch": record["git_branch"],
                "git_origin": record["git_origin_url"],
                "git_sha": record["git_sha"],
                "title": record["title"],
                "preview_len": len(record["preview"] or ""),
                "model": record["model"],
                "reasoning_effort": record["reasoning_effort"],
                "archived": bool(record["archived"]),
                "history_mode": record["history_mode"],
                "tokens_used": record["tokens_used"],
                "agent_nickname": record["agent_nickname"],
                "agent_role": record["agent_role"],
                "agent_path": record["agent_path"],
                "rollout_path": record["rollout_path"],
                "in_window": self.in_window(created),
                "origin": "state_5",
            }
            cover = self.cover(record["id"])
            cover["in_catalogue"] = True
            cover["in_window"] = self.in_window(created)
            if record["cli_version"]:
                self.versions.add(str(record["cli_version"]))
            count += 1
        edges = [
            schema.row(
                "spawn_edges",
                parent_thread_id=parent,
                child_thread_id=child,
                status=status,
                source=SOURCE,
                origin="state_5",
            )
            for parent, child, status in connection.execute(
                "select parent_thread_id, child_thread_id, status from thread_spawn_edges"
            )
        ]
        self.write("spawn_edges", edges)
        connection.close()
        self.phase("catalogue", started, count, f"{how}; spawn edges {len(edges)}")

    # --------------------------------------------------------------- rollouts
    def rollouts(self) -> None:
        assert self.con is not None
        started = time.perf_counter()
        files = sorted((self.home / "sessions").glob("*/*/*/rollout-*.jsonl"))
        files += sorted((self.home / "archived_sessions").glob("rollout-*.jsonl"))
        compressed = len(list((self.home / "sessions").glob("*/*/*/rollout-*.zst")))
        compressed += len(list((self.home / "archived_sessions").glob("rollout-*.zst")))
        total_bytes = 0
        total_lines = 0
        skipped = 0
        for path in files:
            total_bytes += path.stat().st_size
            lines = self.rollout(path)
            if lines is None:
                skipped += 1
            else:
                total_lines += lines
        self.phase(
            "rollouts",
            started,
            total_lines,
            f"files {len(files)}; bytes {total_bytes}; outside window {skipped}; compressed skipped {compressed}",
        )

    def rollout(self, path: Path) -> int | None:
        """Read one rollout; return its line count, or None when outside the window."""
        assert self.con is not None
        responses: list[tuple] = []
        counts: list[tuple] = []
        events: list[tuple] = []
        response_items: list[tuple] = []
        thread_id: str | None = None
        current_turn: str | None = None
        lines = 0
        fmt = "envelope"
        cover: dict[str, Any] | None = None
        with path.open("rb") as stream:
            for number, raw in enumerate(stream):
                lines += 1
                try:
                    record = json.loads(raw)
                except ValueError:
                    if cover is not None:
                        cover["unknown_line_types"] += 1
                        self.unknown("unparseable")
                    continue
                if number == 0:
                    if record.get("type") == "session_meta":
                        payload = record.get("payload") or {}
                        thread_id = payload.get("id")
                    else:
                        fmt = "legacy"
                        thread_id = record.get("id") or path.stem.split("-", 4)[-1]
                        payload = record
                    if not thread_id:
                        return lines
                    cover = self.cover(thread_id)
                    cover["rollout_format"] = fmt
                    anchor = self.session_meta(thread_id, payload, path, fmt)
                    in_window = self.in_window(anchor)
                    cover["in_window"] = in_window
                    self.threads[thread_id]["in_window"] = in_window
                    if not in_window:
                        cover["rollout_lines"] = None
                        return None
                    if fmt == "legacy":
                        continue
                if cover is None or thread_id is None:
                    continue
                if fmt == "legacy":
                    kind = record.get("type") or record.get("record_type")
                    if kind in LEGACY_ITEM_TYPES:
                        response_items.append(
                            schema.row(
                                "response_items",
                                thread_id=thread_id,
                                item_type=kind,
                                role=record.get("role"),
                                name=record.get("name"),
                                call_id=record.get("call_id"),
                                text_len=self.content_length(record),
                                source=SOURCE,
                                origin="rollout-legacy",
                            )
                        )
                        cover["response_items"] += 1
                    else:
                        cover["unknown_line_types"] += 1
                        self.unknown(f"legacy:{kind}")
                    continue
                kind = record.get("type")
                payload = record.get("payload") or {}
                ts = schema.from_iso(record.get("timestamp"))
                ordinal = record.get("ordinal")
                if kind == "turn_context":
                    cover["turn_contexts"] += 1
                    current_turn = payload.get("turn_id") or current_turn
                    self.turn_context(thread_id, payload, ordinal)
                elif kind == "token_usage_record":
                    cover["usage_records"] += 1
                    turn_key = (thread_id, payload.get("turn_id") or "")
                    responses.append(
                        schema.row(
                            "responses",
                            thread_id=thread_id,
                            turn_id=payload.get("turn_id"),
                            root_turn_id=payload.get("root_turn_id"),
                            session_id=payload.get("session_id"),
                            response_id=payload.get("response_id"),
                            ts=ts,
                            rollout_ordinal=ordinal,
                            model=self.turns.get(turn_key, {}).get("model"),
                            **_usage_fields("", payload.get("usage")),
                            **_usage_fields(
                                "turn_",
                                payload.get("turn_token_usage"),
                                ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"),
                            ),
                            **_usage_fields(
                                "thread_",
                                payload.get("thread_token_usage"),
                                ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"),
                            ),
                            source=SOURCE,
                            origin="rollout",
                        )
                    )
                elif kind == "event_msg":
                    sub = payload.get("type")
                    if sub == "token_count":
                        cover["token_counts"] += 1
                        counts.append(self.token_count(thread_id, current_turn, payload, ts, ordinal))
                    elif sub == "item_completed":
                        cover["rollout_item_completed"] += 1
                    else:
                        if sub in {"task_started", "task_complete", "turn_aborted"}:
                            current_turn = payload.get("turn_id") or current_turn
                        self.event(thread_id, payload, ts, ordinal, sub, events)
                elif kind == "response_item":
                    cover["response_items"] += 1
                    meta = payload.get("internal_chat_message_metadata_passthrough") or {}
                    response_items.append(
                        schema.row(
                            "response_items",
                            thread_id=thread_id,
                            turn_id=meta.get("turn_id") or current_turn,
                            ts=ts,
                            create_time=schema.from_ms(meta.get("create_time")),
                            rollout_ordinal=ordinal,
                            item_type=payload.get("type"),
                            role=payload.get("role"),
                            name=payload.get("name"),
                            call_id=payload.get("call_id"),
                            text_len=self.content_length(payload),
                            source=SOURCE,
                            origin="rollout",
                        )
                    )
                elif kind == "compacted":
                    cover["compactions"] += 1
                    history = payload.get("replacement_history") or []
                    events.append(
                        schema.row(
                            "rollout_events",
                            thread_id=thread_id,
                            turn_id=current_turn,
                            ts=ts,
                            rollout_ordinal=ordinal,
                            event_type="compacted",
                            detail=json.dumps({"replacement_history": len(history)}),
                            source=SOURCE,
                            origin="rollout",
                        )
                    )
                elif kind in PASSTHROUGH_EVENTS:
                    events.append(
                        schema.row(
                            "rollout_events",
                            thread_id=thread_id,
                            turn_id=current_turn,
                            ts=ts,
                            rollout_ordinal=ordinal,
                            event_type=kind,
                            source=SOURCE,
                            origin="rollout",
                        )
                    )
                else:
                    cover["unknown_line_types"] += 1
                    self.unknown(str(kind))
        if cover is not None:
            cover["rollout_lines"] = lines
        self.write("responses", responses)
        self.write("token_counts", counts)
        self.write("rollout_events", events)
        self.write("response_items", response_items)
        return lines

    @staticmethod
    def content_length(record: dict[str, Any]) -> int:
        total = 0
        for key in ("content", "output", "input", "arguments", "summary"):
            value = record.get(key)
            if isinstance(value, str):
                total += len(value)
            elif isinstance(value, list):
                for part in value:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        total += len(part["text"])
                    elif isinstance(part, str):
                        total += len(part)
        return total

    def session_meta(self, thread_id: str, payload: dict[str, Any], path: Path, fmt: str) -> datetime | None:
        """Merge a rollout's first line into the thread record; return the window anchor."""
        git = payload.get("git") or {}
        thread = self.threads.get(thread_id)
        if thread is None:
            thread = self.threads[thread_id] = {
                "thread_id": thread_id,
                "origin": "rollout-legacy" if fmt == "legacy" else "rollout",
                "archived": "archived_sessions" in path.parts,
            }
        thread.update(
            session_id=payload.get("session_id"),
            forked_from_id=payload.get("forked_from_id"),
            parent_thread_id=payload.get("parent_thread_id"),
            rollout_bytes=path.stat().st_size,
            rollout_format=fmt,
        )
        meta_time = schema.from_iso(payload.get("timestamp"))
        thread.setdefault("created_at", meta_time)
        thread.setdefault("cwd", payload.get("cwd"))
        thread.setdefault("originator", payload.get("originator"))
        thread.setdefault("cli_version", payload.get("cli_version"))
        thread.setdefault("model_provider", payload.get("model_provider"))
        thread.setdefault("history_mode", payload.get("history_mode"))
        for key, value in (
            ("git_branch", git.get("branch")),
            ("git_origin", git.get("repository_url")),
            ("git_sha", git.get("commit_hash")),
        ):
            if not thread.get(key) and value:
                thread[key] = value
        if not thread.get("repo"):
            thread["repo"] = repo_from_origin(thread.get("git_origin"))
        if payload.get("cli_version"):
            self.versions.add(str(payload["cli_version"]))
        thread.setdefault("rollout_path", str(path))
        if thread.get("source_kind") is None:
            source = payload.get("source")
            thread["source_kind"] = next(iter(source)) if isinstance(source, dict) and source else source
        thread.setdefault("thread_source", payload.get("thread_source"))
        thread.setdefault("agent_nickname", payload.get("agent_nickname"))
        thread.setdefault("agent_role", payload.get("agent_role"))
        anchor = thread.get("created_at") or meta_time
        if anchor is None:
            anchor = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).replace(tzinfo=None)
        return anchor

    def turn_context(self, thread_id: str, payload: dict[str, Any], ordinal: int | None) -> None:
        turn_id = payload.get("turn_id")
        if not turn_id:
            return
        turn = self.turns.setdefault(
            (thread_id, turn_id), {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"}
        )
        if turn.get("model"):
            return
        settings = (payload.get("collaboration_mode") or {}).get("settings") or {}
        sandbox = payload.get("sandbox_policy") or {}
        turn.update(
            root_turn_id=turn.get("root_turn_id") or payload.get("root_turn_id"),
            rollout_ordinal=turn.get("rollout_ordinal") if turn.get("rollout_ordinal") is not None else ordinal,
            model=payload.get("model") or settings.get("model"),
            reasoning_effort=payload.get("effort") or settings.get("reasoning_effort"),
            cwd=payload.get("cwd"),
            approval_policy=payload.get("approval_policy"),
            sandbox_type=sandbox.get("type") if isinstance(sandbox, dict) else str(sandbox),
            personality=payload.get("personality"),
            collaboration_mode=(payload.get("collaboration_mode") or {}).get("mode"),
        )

    def token_count(
        self, thread_id: str, turn_id: str | None, payload: dict[str, Any], ts: Any, ordinal: int | None
    ) -> tuple:
        info = payload.get("info") or {}
        limits = payload.get("rate_limits") or {}
        primary = limits.get("primary") or {}
        secondary = limits.get("secondary") or {}
        credits = limits.get("credits") or {}
        balance = credits.get("balance")
        try:
            balance = float(balance) if balance is not None else None
        except (TypeError, ValueError):
            balance = None
        totals = _usage_fields("total_", info.get("total_token_usage"))
        totals["total_tokens"] = totals.pop("total_total_tokens")
        return schema.row(
            "token_counts",
            thread_id=thread_id,
            turn_id=turn_id,
            ts=ts,
            rollout_ordinal=ordinal,
            **totals,
            **_usage_fields("last_", info.get("last_token_usage")),
            model_context_window=info.get("model_context_window"),
            limit_id=limits.get("limit_id"),
            plan_type=limits.get("plan_type"),
            primary_used_percent=primary.get("used_percent"),
            primary_window_minutes=primary.get("window_minutes"),
            primary_resets_at=schema.from_ms(primary.get("resets_at")),
            secondary_used_percent=secondary.get("used_percent"),
            secondary_window_minutes=secondary.get("window_minutes"),
            secondary_resets_at=schema.from_ms(secondary.get("resets_at")),
            credits_balance=balance,
            credits_unlimited=credits.get("unlimited"),
            rate_limit_reached_type=limits.get("rate_limit_reached_type"),
            source=SOURCE,
            origin="rollout",
        )

    def event(
        self,
        thread_id: str,
        payload: dict[str, Any],
        ts: Any,
        ordinal: int | None,
        sub: str | None,
        events: list[tuple],
    ) -> None:
        turn_id = payload.get("turn_id")
        detail: dict[str, Any] = {}
        turn = None
        if turn_id and sub in {"task_started", "task_complete", "turn_aborted"}:
            turn = self.turns.setdefault(
                (thread_id, turn_id), {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"}
            )
        if sub == "task_started":
            detail = {
                "model_context_window": payload.get("model_context_window"),
                "collaboration_mode_kind": payload.get("collaboration_mode_kind"),
            }
            if turn is not None:
                turn.setdefault("root_turn_id", payload.get("root_turn_id"))
                turn["model_context_window"] = payload.get("model_context_window")
                if not turn.get("started_at"):
                    turn["started_at"] = schema.from_ms(payload.get("started_at")) or ts
        elif sub == "task_complete":
            detail = {
                "duration_ms": payload.get("duration_ms"),
                "time_to_first_token_ms": payload.get("time_to_first_token_ms"),
                "last_agent_message_len": len(payload.get("last_agent_message") or ""),
            }
            if turn is not None:
                turn["time_to_first_token_ms"] = payload.get("time_to_first_token_ms")
                if not turn.get("completed_at"):
                    turn["completed_at"] = schema.from_ms(payload.get("completed_at")) or ts
                if turn.get("duration_ms") is None:
                    turn["duration_ms"] = payload.get("duration_ms")
                turn.setdefault("status", "completed")
        elif sub == "turn_aborted":
            detail = {"reason": payload.get("reason")}
            if turn is not None:
                turn.setdefault("status", "interrupted")
        elif sub == "thread_settings_applied":
            settings = payload.get("thread_settings") or {}
            detail = {
                "model": settings.get("model"),
                "reasoning_effort": settings.get("reasoning_effort"),
                "service_tier": settings.get("service_tier"),
                "personality": settings.get("personality"),
            }
        else:
            detail = {key: payload.get(key) for key in ("reason", "message", "kind") if key in payload}
        events.append(
            schema.row(
                "rollout_events",
                thread_id=thread_id,
                turn_id=turn_id,
                ts=ts,
                rollout_ordinal=ordinal,
                event_type=sub,
                detail=json.dumps(detail) if detail else None,
                source=SOURCE,
                origin="rollout",
            )
        )

    # ------------------------------------------------------------- projection
    def projection(self) -> None:
        assert self.con is not None
        started = time.perf_counter()
        path = self.home / "thread_history_1.sqlite"
        if not path.exists():
            self.summary.notes.append("thread_history_1.sqlite absent")
            self.phase("projection", started, 0, "absent")
            return
        connection, how = open_readonly(path)
        connection.row_factory = sqlite3.Row
        turn_rows = 0
        skipped_turns = 0
        for record in connection.execute("select * from thread_turns"):
            if not self.thread_in_window(record["thread_id"], record["started_at"]):
                skipped_turns += 1
                continue
            error_message = error_kind = None
            if record["error_json"]:
                try:
                    error = json.loads(record["error_json"])
                    error_message = (error.get("message") or "")[:500]
                    info = error.get("codexErrorInfo")
                    error_kind = info if isinstance(info, str) else json.dumps(info)[:120] if info else None
                except ValueError:
                    error_message = record["error_json"][:500]
            key = (record["thread_id"], record["turn_id"])
            existing = self.turns.get(key, {})
            existing.update(
                {
                    "thread_id": record["thread_id"],
                    "turn_id": record["turn_id"],
                    "root_turn_id": existing.get("root_turn_id") or record["root_turn_id"],
                    "rollout_ordinal": record["rollout_ordinal"],
                    "status": record["status"],
                    "error_message": error_message,
                    "error_kind": error_kind,
                    "started_at": schema.from_ms(record["started_at"]) or existing.get("started_at"),
                    "completed_at": schema.from_ms(record["completed_at"]) or existing.get("completed_at"),
                    "duration_ms": record["duration_ms"]
                    if record["duration_ms"] is not None
                    else existing.get("duration_ms"),
                    "origin": "thread_history_1+rollout" if existing.get("model") else "thread_history_1",
                }
            )
            self.turns[key] = existing
            cover = self.cover(record["thread_id"])
            cover["in_projection"] = True
            cover["projection_turns"] += 1
            turn_rows += 1
        batch: list[tuple] = []
        blobs: list[tuple] = []
        item_rows = 0
        skipped_items = 0
        cursor = connection.execute(
            "select thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, started_at_ms, completed_at_ms, "
            "item_type, item_json from thread_items"
        )
        while True:
            chunk = cursor.fetchmany(2000)
            if not chunk:
                break
            for record in chunk:
                if not self.thread_in_window(record["thread_id"], record["created_at_ms"]):
                    skipped_items += 1
                    continue
                raw = record["item_json"]
                try:
                    item = json.loads(raw)
                except ValueError:
                    item = {"type": record["item_type"], "id": record["item_id"]}
                columns = item_columns.extract(item)
                duration = None
                if record["started_at_ms"] and record["completed_at_ms"]:
                    duration = record["completed_at_ms"] - record["started_at_ms"]
                columns.update(
                    thread_id=record["thread_id"],
                    turn_id=record["turn_id"],
                    item_id=record["item_id"],
                    rollout_ordinal=record["rollout_ordinal"],
                    item_type=record["item_type"] or columns.get("item_type"),
                    created_at=schema.from_ms(record["created_at_ms"]),
                    started_at=schema.from_ms(record["started_at_ms"]),
                    completed_at=schema.from_ms(record["completed_at_ms"]),
                    duration_ms=duration,
                    item_json_bytes=len(raw),
                    source=SOURCE,
                    origin="thread_history_1",
                )
                batch.append(schema.row("items", **columns))
                if self.blobs:
                    blobs.append(
                        schema.row(
                            "item_blobs",
                            thread_id=record["thread_id"],
                            turn_id=record["turn_id"],
                            item_id=record["item_id"],
                            item_json=raw,
                            source=SOURCE,
                            origin="thread_history_1",
                        )
                    )
                cover = self.cover(record["thread_id"])
                cover["in_projection"] = True
                cover["projection_items"] += 1
                item_rows += 1
            self.write("items", batch)
            self.write("item_blobs", blobs)
            batch.clear()
            blobs.clear()
        connection.close()
        self.phase(
            "projection",
            started,
            item_rows,
            f"{how}; turns {turn_rows}; blobs {self.blobs}; outside window turns {skipped_turns} items {skipped_items}",
        )

    def thread_in_window(self, thread_id: str, fallback_ms: Any) -> bool:
        """Decide membership for a projection row by its thread, else by its own timestamp."""
        cover = self.coverage.get(thread_id)
        if cover is not None:
            return bool(cover["in_window"])
        return self.in_window(schema.from_ms(fallback_ms))

    # ------------------------------------------------------------------- logs
    def logs(self) -> None:
        assert self.con is not None
        started = time.perf_counter()
        path = self.home / "logs_2.sqlite"
        if not path.exists():
            self.summary.notes.append("logs_2.sqlite absent")
            self.phase("logs", started, 0, "absent")
            return
        connection, how = open_readonly(path)
        rows = []
        cutoff_seconds = self.cutoff.replace(tzinfo=UTC).timestamp() if self.cutoff else 0
        query = "select ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid from logs where ts >= ?"
        for ts, nanos, level, target, body, thread_id, process_uuid in connection.execute(query, (cutoff_seconds,)):
            moment = datetime.fromtimestamp(ts + (nanos or 0) / 1e9, tz=UTC).replace(tzinfo=None) if ts else None
            rows.append(
                schema.row(
                    "logs",
                    ts=moment,
                    level=level,
                    target=target,
                    thread_id=thread_id,
                    process_uuid=process_uuid,
                    body=(body or "")[:2000] if level in {"WARN", "ERROR"} else None,
                    source=SOURCE,
                    origin="logs_2",
                )
            )
        connection.close()
        self.write("logs", rows)
        self.phase("logs", started, len(rows), how)

    # ----------------------------------------------------------------- finish
    def finish(self) -> None:
        assert self.con is not None
        started = time.perf_counter()
        thread_columns = dict(schema.COLUMNS["threads"])
        thread_rows = []
        for thread in self.threads.values():
            thread.setdefault("source", SOURCE)
            thread.setdefault("in_window", True)
            thread_rows.append(schema.row("threads", **{k: v for k, v in thread.items() if k in thread_columns}))
        self.write("threads", thread_rows)
        turn_rows = [
            schema.row("turns", **{**turn, "source": SOURCE})
            for turn in self.turns.values()
            if self.coverage.get(turn["thread_id"], {}).get("in_window", True)
        ]
        self.write("turns", turn_rows)
        cover_rows = self.write_coverage_and_meta()
        self.phase(
            "finish",
            started,
            len(thread_rows) + len(turn_rows) + cover_rows,
            f"threads {len(thread_rows)}; turns {len(turn_rows)}; coverage {cover_rows}",
        )


def ingest_codex_home(
    home: Path | None = None,
    db_path: Path | None = None,
    *,
    window_days: int | None = DEFAULT_WINDOW_DAYS,
    blobs: bool = True,
    now: datetime | None = None,
) -> IngestSummary:
    """Ingest a Codex home into a DuckDB file.

    Parameters
    ----------
    home : Path or None
        Codex home; defaults to ``$CODEX_HOME`` or ``~/.codex``.
    db_path : Path or None
        Target DuckDB file; defaults to ``codex-history.duckdb`` in the current directory.
    window_days : int or None
        Support window in days; None ingests everything.
    blobs : bool
        Store full item JSON in ``item_blobs``.
    now : datetime or None
        Reference time for the window, for tests.

    Returns
    -------
    IngestSummary
        Phase timings, row counts and notes.
    """
    ingest = CodexIngest(
        home or default_codex_home(),
        db_path or Path("codex-history.duckdb"),
        window_days=window_days,
        blobs=blobs,
        now=now,
    )
    return ingest.run()
