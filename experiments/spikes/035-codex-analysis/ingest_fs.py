# ruff: noqa: E501  -- SQL view text reads better unwrapped; research code, not a package
"""Filesystem ingester: a Codex home's SQLite databases and rollout files into DuckDB.

Read-only by intent. SQLite files open with ``mode=ro`` first; a WAL database whose
``-shm`` side file is absent refuses that, and the fallback is an ordinary connection
with ``PRAGMA query_only``, which only creates the side file Codex itself creates.

Run from experiments with the parent workspace plus DuckDB:

    uv run --project .. --with duckdb==1.5.6 python spikes/035-codex-analysis/ingest_fs.py \
        --home ~/.codex --out artifacts/035-codex-analysis/<run>
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import items as item_columns  # noqa: E402
import schema  # noqa: E402

SOURCE = "fs"

USAGE_EVENTS_VIEW = """
CREATE OR REPLACE VIEW usage_events AS
SELECT thread_id, turn_id, ts, rollout_ordinal, input_tokens, cached_input_tokens, cache_write_input_tokens,
       output_tokens, reasoning_output_tokens, total_tokens, 'token_usage_record' AS basis
FROM (SELECT * FROM responses QUALIFY row_number() OVER (PARTITION BY response_id ORDER BY ts, rollout_ordinal) = 1)
UNION ALL
SELECT thread_id, turn_id, ts, rollout_ordinal,
       total_input_tokens - prev_input, total_cached_input_tokens - prev_cached, total_cache_write_input_tokens - prev_cache_write,
       total_output_tokens - prev_output, total_reasoning_output_tokens - prev_reasoning, total_tokens - prev_total, 'token_count_delta' AS basis
FROM (SELECT *,
             lag(total_input_tokens, 1, 0) OVER w AS prev_input, lag(total_cached_input_tokens, 1, 0) OVER w AS prev_cached,
             lag(COALESCE(total_cache_write_input_tokens, 0), 1, 0) OVER w AS prev_cache_write, lag(total_output_tokens, 1, 0) OVER w AS prev_output,
             lag(total_reasoning_output_tokens, 1, 0) OVER w AS prev_reasoning, lag(total_tokens, 1, 0) OVER w AS prev_total
      FROM token_counts
      WHERE total_tokens IS NOT NULL AND thread_id NOT IN (SELECT DISTINCT thread_id FROM responses)
      WINDOW w AS (PARTITION BY thread_id ORDER BY rollout_ordinal))
WHERE total_tokens - prev_total > 0
"""
"""Per-response usage where Codex recorded it, else positive deltas of the cumulative counters.

Threads that have ``token_usage_record`` lines are never double counted because the delta
branch excludes them. The first counter value of a thread counts as an increment from zero;
a fork inherits its parent's counters, so that first increment can include inherited history.
"""


def open_sqlite(path: Path) -> tuple[sqlite3.Connection, str]:
    """Open read-only, falling back to query-only when the WAL side file is missing."""
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        connection.execute("select count(*) from sqlite_master").fetchone()
        return connection, "mode=ro"
    except sqlite3.OperationalError as error:
        if "unable to open database" not in str(error):
            raise
    connection = sqlite3.connect(str(path), timeout=5)
    connection.execute("PRAGMA query_only = 1")
    return connection, "query_only fallback (-shm absent)"


def usage_fields(prefix: str, usage: dict[str, Any] | None) -> dict[str, Any]:
    usage = usage or {}
    keys = {
        "input_tokens": "input_tokens",
        "cached_input_tokens": "cached_input_tokens",
        "cache_write_input_tokens": "cache_write_input_tokens",
        "output_tokens": "output_tokens",
        "reasoning_output_tokens": "reasoning_output_tokens",
        "total_tokens": "total_tokens",
    }
    return {f"{prefix}{column}": usage.get(key) for key, column in keys.items()}


class Ingest:
    def __init__(self, home: Path, out: Path, *, outputs: bool) -> None:
        self.home = home
        self.out = out
        self.outputs = outputs
        self.run_id = uuid.uuid4().hex[:12]
        out.mkdir(parents=True, exist_ok=True)
        self.db_path = out / "fs.duckdb"
        if self.db_path.exists():
            self.db_path.unlink()
        self.con = duckdb.connect(str(self.db_path))
        schema.create(self.con)
        self.summary: dict[str, Any] = {
            "run_id": self.run_id,
            "home": str(home),
            "phases": {},
            "notes": [],
            "unknown_line_types": {},
        }
        self.threads: dict[str, dict[str, Any]] = {}
        self.turns: dict[tuple[str, str], dict[str, Any]] = {}
        self.coverage: dict[str, dict[str, Any]] = {}

    def phase(self, name: str, started: float, rows: int, detail: str = "") -> None:
        seconds = time.perf_counter() - started
        self.summary["phases"][name] = {"seconds": round(seconds, 3), "rows": rows, "detail": detail}
        print(f"phase {name}: {seconds:.1f}s rows={rows} {detail}", file=sys.stderr, flush=True)
        schema.insert(
            self.con,
            "ingest_runs",
            [
                schema.row(
                    "ingest_runs",
                    run_id=self.run_id,
                    source=SOURCE,
                    phase=name,
                    started_at=datetime.now(UTC).replace(tzinfo=None),
                    seconds=seconds,
                    rows=rows,
                    detail=detail,
                )
            ],
        )

    def cover(self, thread_id: str) -> dict[str, Any]:
        return self.coverage.setdefault(
            thread_id,
            {
                "thread_id": thread_id,
                "in_catalogue": False,
                "in_projection": False,
                "rollout_format": None,
                "rollout_lines": 0,
                "turn_contexts": 0,
                "usage_records": 0,
                "token_counts": 0,
                "projection_turns": 0,
                "projection_items": 0,
                "rollout_item_completed": 0,
                "response_items": 0,
                "compactions": 0,
                "unknown_line_types": 0,
            },
        )

    # ------------------------------------------------------------------ catalogue
    def catalogue(self) -> None:
        started = time.perf_counter()
        path = self.home / "state_5.sqlite"
        if not path.exists():
            self.summary["notes"].append("state_5.sqlite absent")
            return
        connection, how = open_sqlite(path)
        connection.row_factory = sqlite3.Row
        count = 0
        for record in connection.execute("select * from threads"):
            source = record["source"] or ""
            source_kind = source
            if source.startswith("{"):
                try:
                    parsed = json.loads(source)
                    source_kind = next(iter(parsed)) if isinstance(parsed, dict) else source[:32]
                except ValueError:
                    source_kind = source[:32]
            self.threads[record["id"]] = {
                "thread_id": record["id"],
                "created_at": schema.from_ms(record["created_at_ms"] or record["created_at"]),
                "updated_at": schema.from_ms(record["updated_at_ms"] or record["updated_at"]),
                "source_kind": source_kind,
                "thread_source": record["thread_source"],
                "originator": record["originator"],
                "cli_version": record["cli_version"],
                "model_provider": record["model_provider"],
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
                "origin": "state_5",
            }
            self.cover(record["id"])["in_catalogue"] = True
            count += 1
        edges = [
            schema.row(
                "spawn_edges",
                parent_thread_id=r["parent_thread_id"],
                child_thread_id=r["child_thread_id"],
                status=r["status"],
                source=SOURCE,
                origin="state_5",
            )
            for r in connection.execute("select * from thread_spawn_edges")
        ]
        schema.insert(self.con, "spawn_edges", edges)
        connection.close()
        self.phase("catalogue", started, count, f"{how}; spawn edges {len(edges)}")

    # ----------------------------------------------------------------- projection
    def projection(self) -> None:
        started = time.perf_counter()
        path = self.home / "thread_history_1.sqlite"
        if not path.exists():
            self.summary["notes"].append("thread_history_1.sqlite absent")
            return
        connection, how = open_sqlite(path)
        connection.row_factory = sqlite3.Row
        turn_rows = 0
        for record in connection.execute("select * from thread_turns"):
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
            self.turns[key] = {
                "thread_id": record["thread_id"],
                "turn_id": record["turn_id"],
                "root_turn_id": record["root_turn_id"],
                "rollout_ordinal": record["rollout_ordinal"],
                "status": record["status"],
                "error_message": error_message,
                "error_kind": error_kind,
                "started_at": schema.from_ms(record["started_at"]),
                "completed_at": schema.from_ms(record["completed_at"]),
                "duration_ms": record["duration_ms"],
                "origin": "thread_history_1",
            }
            cover = self.cover(record["thread_id"])
            cover["in_projection"] = True
            cover["projection_turns"] += 1
            turn_rows += 1
        batch: list[tuple] = []
        outputs: list[tuple] = []
        item_rows = 0
        cursor = connection.execute(
            "select thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, started_at_ms, completed_at_ms, item_type, item_json from thread_items"
        )
        while True:
            chunk = cursor.fetchmany(2000)
            if not chunk:
                break
            for record in chunk:
                raw = record["item_json"]
                try:
                    item = json.loads(raw)
                except ValueError:
                    item = {"type": record["item_type"], "id": record["item_id"]}
                columns = item_columns.extract(item)
                output = columns.pop("_output", None)
                started_at = schema.from_ms(record["started_at_ms"])
                completed_at = schema.from_ms(record["completed_at_ms"])
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
                    started_at=started_at,
                    completed_at=completed_at,
                    duration_ms=duration,
                    item_json_bytes=len(raw),
                    source=SOURCE,
                    origin="thread_history_1",
                )
                batch.append(schema.row("items", **columns))
                if self.outputs and isinstance(output, str) and output:
                    outputs.append(
                        schema.row(
                            "command_outputs",
                            thread_id=record["thread_id"],
                            turn_id=record["turn_id"],
                            item_id=record["item_id"],
                            output=output,
                            source=SOURCE,
                            origin="thread_history_1",
                        )
                    )
                cover = self.cover(record["thread_id"])
                cover["in_projection"] = True
                cover["projection_items"] += 1
                item_rows += 1
            schema.insert(self.con, "items", batch)
            schema.insert(self.con, "command_outputs", outputs)
            batch.clear()
            outputs.clear()
        connection.close()
        self.phase("projection", started, item_rows, f"{how}; turns {turn_rows}; outputs stored {self.outputs}")

    # ------------------------------------------------------------------- rollouts
    def rollouts(self) -> None:
        started = time.perf_counter()
        files = sorted((self.home / "sessions").glob("*/*/*/rollout-*.jsonl")) + sorted(
            (self.home / "archived_sessions").glob("rollout-*.jsonl")
        )
        compressed = len(list((self.home / "sessions").glob("*/*/*/rollout-*.zst"))) + len(
            list((self.home / "archived_sessions").glob("rollout-*.zst"))
        )
        total_bytes = 0
        total_lines = 0
        for path in files:
            total_bytes += path.stat().st_size
            total_lines += self.rollout(path)
        self.phase(
            "rollouts",
            started,
            total_lines,
            f"files {len(files)}; bytes {total_bytes}; compressed skipped {compressed}",
        )

    def rollout(self, path: Path) -> int:
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
                    if cover:
                        cover["unknown_line_types"] += 1
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
                    self.session_meta(thread_id, payload, path, fmt)
                    if fmt == "legacy":
                        continue
                if cover is None or thread_id is None:
                    continue
                if fmt == "legacy":
                    kind = record.get("type") or record.get("record_type")
                    if kind in {
                        "message",
                        "function_call",
                        "function_call_output",
                        "reasoning",
                        "local_shell_call",
                        "custom_tool_call",
                        "custom_tool_call_output",
                        "web_search_call",
                    }:
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
                        unknown = self.summary["unknown_line_types"]
                        unknown[f"legacy:{kind}"] = unknown.get(f"legacy:{kind}", 0) + 1
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
                            **usage_fields("", payload.get("usage")),
                            **{
                                k: v
                                for k, v in usage_fields("turn_", payload.get("turn_token_usage")).items()
                                if k
                                in {
                                    "turn_input_tokens",
                                    "turn_cached_input_tokens",
                                    "turn_output_tokens",
                                    "turn_total_tokens",
                                }
                            },
                            **{
                                k: v
                                for k, v in usage_fields("thread_", payload.get("thread_token_usage")).items()
                                if k
                                in {
                                    "thread_input_tokens",
                                    "thread_cached_input_tokens",
                                    "thread_output_tokens",
                                    "thread_total_tokens",
                                }
                            },
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
                elif kind in {
                    "world_state",
                    "inter_agent_communication",
                    "inter_agent_communication_metadata",
                    "realtime_item",
                    "session_meta",
                }:
                    events.append(
                        schema.row(
                            "rollout_events",
                            thread_id=thread_id,
                            turn_id=current_turn,
                            ts=ts,
                            rollout_ordinal=ordinal,
                            event_type=kind,
                            detail=None,
                            source=SOURCE,
                            origin="rollout",
                        )
                    )
                else:
                    cover["unknown_line_types"] += 1
                    unknown = self.summary["unknown_line_types"]
                    unknown[str(kind)] = unknown.get(str(kind), 0) + 1
        if cover is not None:
            cover["rollout_lines"] = lines
        schema.insert(self.con, "responses", responses)
        schema.insert(self.con, "token_counts", counts)
        schema.insert(self.con, "rollout_events", events)
        schema.insert(self.con, "response_items", response_items)
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

    def session_meta(self, thread_id: str, payload: dict[str, Any], path: Path, fmt: str) -> None:
        git = payload.get("git") or {}
        thread = self.threads.get(thread_id)
        if thread is None:
            thread = self.threads[thread_id] = {
                "thread_id": thread_id,
                "origin": f"rollout-{fmt}" if fmt == "legacy" else "rollout",
                "archived": "archived_sessions" in path.parts,
            }
        thread.update(
            session_id=payload.get("session_id"),
            forked_from_id=payload.get("forked_from_id"),
            parent_thread_id=payload.get("parent_thread_id"),
            rollout_bytes=path.stat().st_size,
            rollout_format=fmt,
        )
        thread.setdefault("created_at", schema.from_iso(payload.get("timestamp")))
        thread.setdefault("cwd", payload.get("cwd"))
        thread.setdefault("originator", payload.get("originator"))
        thread.setdefault("cli_version", payload.get("cli_version"))
        thread.setdefault("model_provider", payload.get("model_provider"))
        thread.setdefault("history_mode", payload.get("history_mode"))
        thread.setdefault("git_branch", git.get("branch"))
        thread.setdefault("git_origin", git.get("repository_url"))
        thread.setdefault("git_sha", git.get("commit_hash"))
        thread.setdefault("rollout_path", str(path))
        if thread.get("source_kind") is None:
            source = payload.get("source")
            thread["source_kind"] = next(iter(source)) if isinstance(source, dict) and source else source
        thread.setdefault("thread_source", payload.get("thread_source"))
        thread.setdefault("agent_nickname", payload.get("agent_nickname"))
        thread.setdefault("agent_role", payload.get("agent_role"))

    def turn_context(self, thread_id: str, payload: dict[str, Any], ordinal: int | None) -> None:
        turn_id = payload.get("turn_id")
        if not turn_id:
            return
        key = (thread_id, turn_id)
        turn = self.turns.setdefault(key, {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"})
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
        if turn.get("origin") == "thread_history_1":
            turn["origin"] = "thread_history_1+rollout"

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
        totals = usage_fields("total_", info.get("total_token_usage"))
        totals["total_tokens"] = totals.pop("total_total_tokens")
        return schema.row(
            "token_counts",
            thread_id=thread_id,
            turn_id=turn_id,
            ts=ts,
            rollout_ordinal=ordinal,
            **totals,
            **usage_fields("last_", info.get("last_token_usage")),
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
        if sub == "task_started":
            detail = {
                "model_context_window": payload.get("model_context_window"),
                "collaboration_mode_kind": payload.get("collaboration_mode_kind"),
            }
            if turn_id:
                turn = self.turns.setdefault(
                    (thread_id, turn_id), {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"}
                )
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
            if turn_id:
                turn = self.turns.setdefault(
                    (thread_id, turn_id), {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"}
                )
                turn["time_to_first_token_ms"] = payload.get("time_to_first_token_ms")
                if not turn.get("completed_at"):
                    turn["completed_at"] = schema.from_ms(payload.get("completed_at")) or ts
                if turn.get("duration_ms") is None:
                    turn["duration_ms"] = payload.get("duration_ms")
                turn.setdefault("status", "completed")
        elif sub == "turn_aborted":
            detail = {"reason": payload.get("reason")}
            if turn_id:
                turn = self.turns.setdefault(
                    (thread_id, turn_id), {"thread_id": thread_id, "turn_id": turn_id, "origin": "rollout"}
                )
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

    # ----------------------------------------------------------------------- logs
    def logs(self) -> None:
        started = time.perf_counter()
        path = self.home / "logs_2.sqlite"
        if not path.exists():
            self.summary["notes"].append("logs_2.sqlite absent")
            return
        connection, how = open_sqlite(path)
        rows = []
        for ts, nanos, level, target, body, thread_id, process_uuid in connection.execute(
            "select ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid from logs"
        ):
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
        schema.insert(self.con, "logs", rows)
        self.phase("logs", started, len(rows), how)

    # --------------------------------------------------------------------- finish
    def finish(self) -> None:
        started = time.perf_counter()
        thread_rows = []
        for thread in self.threads.values():
            thread.setdefault("source", SOURCE)
            thread_rows.append(
                schema.row("threads", **{k: v for k, v in thread.items() if k in dict(schema.COLUMNS["threads"])})
            )
        schema.insert(self.con, "threads", thread_rows)
        turn_rows = [schema.row("turns", **{**turn, "source": SOURCE}) for turn in self.turns.values()]
        schema.insert(self.con, "turns", turn_rows)
        cover_rows = [
            schema.row("coverage", **cover, source=SOURCE, origin="ingest_fs") for cover in self.coverage.values()
        ]
        schema.insert(self.con, "coverage", cover_rows)
        self.phase(
            "finish",
            started,
            len(thread_rows) + len(turn_rows) + len(cover_rows),
            f"threads {len(thread_rows)}; turns {len(turn_rows)}; coverage {len(cover_rows)}",
        )
        self.con.execute(USAGE_EVENTS_VIEW)
        counts = {table: self.con.execute(f"select count(*) from {table}").fetchone()[0] for table in schema.COLUMNS}
        self.con.execute("CHECKPOINT")
        self.con.close()
        self.summary["tables"] = counts
        self.summary["db_bytes"] = self.db_path.stat().st_size
        self.summary["finished_at"] = datetime.now(UTC).isoformat()
        (self.out / "ingest_fs.json").write_text(json.dumps(self.summary, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--out", required=True, help="artifact directory for fs.duckdb and ingest_fs.json")
    parser.add_argument("--no-outputs", action="store_true", help="do not store command outputs")
    args = parser.parse_args()
    os.umask(0o077)
    home = Path(args.home).expanduser().resolve()
    if not home.is_dir():
        raise SystemExit(f"not a directory: {home}")
    total = time.perf_counter()
    ingest = Ingest(home, Path(args.out).expanduser().resolve(), outputs=not args.no_outputs)
    ingest.catalogue()
    ingest.projection()
    ingest.rollouts()
    ingest.logs()
    ingest.finish()
    ingest.summary["total_seconds"] = round(time.perf_counter() - total, 3)
    (ingest.out / "ingest_fs.json").write_text(json.dumps(ingest.summary, indent=2) + "\n")
    print(
        json.dumps(
            {k: ingest.summary[k] for k in ("run_id", "total_seconds", "db_bytes", "tables", "phases", "notes")},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
