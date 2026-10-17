"""Read a Claude Code configuration directory into the shared DuckDB schema.

Claude Code keeps one JSONL file per session under ``projects/<cwd-slug>/<session>.jsonl`` and
one file per sub-agent under ``projects/<cwd-slug>/<session>/subagents/agent-<id>.jsonl``.
Lines form a tree through ``uuid`` and ``parentUuid``; assistant lines carry the model, effort
and a usage block per API response; tool calls and results are content blocks paired by id.
There is no turn record, so turns are derived from user prompts. Sub-agents become their own
threads with the session as parent. Older storage formats are counted, not modelled.

A continued or forked session copies its inherited transcript into the new file, ids and
timestamps included. Since Claude Code 2.1.199 every copied message keeps the id of the session
that produced it in ``session_id`` while ``sessionId`` names the file, so the marker decides what a
file owns and names the direct predecessor (the last foreign producer before the file's own
messages). Files without markers fall back to uuid ownership by start order. Sub-agents since
2.1.220 reference the parent's context (``fork-context-ref``) instead of copying it.
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import items as item_columns
from . import schema
from .base import DEFAULT_WINDOW_DAYS, BaseIngest, IngestSummary, assign_lineage

SOURCE = "claude-fs"
FORMAT = "claude-jsonl"
METADATA_TYPES = {
    "agent-setting",
    "mode",
    "permission-mode",
    "atis-latch",
    "last-prompt",
    "agent-name",
    "relocated",
    "worktree-state",
    "file-history-snapshot",
    "file-history-delta",
    "api-request-blob",
    "api-request-shape",
    "artifact-autoreact-ledger",
    "artifact-comment-monitor",
    "bridge-session",
    "frame-link",
    "queue-operation",
}
"""Line types that carry no session facts we model; they are counted as ignored."""

WORKFLOW_TYPES = {"launched", "started", "result"}
"""Workflow-tool orchestration records inside ``subagents/workflows/`` files."""

COPIED = "copied-context"

TOTAL_INDEX = [name for name, _ in schema.COLUMNS["responses"]].index("total_tokens")
"""Origin of lines a file copies from another session or from a parent before its own first prompt."""

EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
SEARCH_TOOLS = {"WebSearch", "WebFetch"}
SUMMARY_KEYS = ("file_path", "notebook_path", "pattern", "path", "query", "url", "description", "prompt", "skill")


def default_claude_dir() -> Path:
    """Return ``$CLAUDE_CONFIG_DIR`` or ``~/.claude``."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser()


def patch_line_counts(patch: Any) -> tuple[int, int] | None:
    """Count added and deleted lines in a Claude ``structuredPatch`` list of hunks."""
    if not isinstance(patch, list):
        return None
    added = deleted = 0
    for hunk in patch:
        for line in (hunk or {}).get("lines") or []:
            if isinstance(line, str):
                if line.startswith("+"):
                    added += 1
                elif line.startswith("-"):
                    deleted += 1
    return added, deleted


def _lines(text: Any) -> int:
    return len(text.splitlines()) if isinstance(text, str) and text else 0


def _block_text(content: Any) -> tuple[str, int]:
    """Return the concatenated text and image count of a content value."""
    if isinstance(content, str):
        return content, 0
    texts: list[str] = []
    images = 0
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    texts.append(part["text"])
                elif part.get("type") == "image":
                    images += 1
            elif isinstance(part, str):
                texts.append(part)
    return "\n".join(texts), images


class _Thread:
    """Mutable state for one thread while its file is read."""

    def __init__(self, thread_id: str, *, parent: str | None, path: Path) -> None:
        self.thread_id = thread_id
        self.parent = parent
        self.path = path
        self.record: dict[str, Any] = {
            "thread_id": thread_id,
            "parent_thread_id": parent,
            "source_kind": "claude-subagent" if parent else "claude",
            "rollout_path": str(path),
            "rollout_bytes": path.stat().st_size,
            "rollout_format": FORMAT,
            "archived": False,
            "origin": "session-jsonl",
        }
        self.turns: list[dict[str, Any]] = []
        self.turn_ids: set[str] = set()
        self.responses: dict[str, dict[str, Any]] = {}
        self.items: dict[str, dict[str, Any]] = {}
        self.blobs: dict[str, dict[str, Any]] = {}
        self.events: list[tuple] = []
        self.response_items: list[tuple] = []
        self.models: Counter[str] = Counter()
        self.efforts: Counter[str] = Counter()
        self.titles: dict[str, str] = {}
        self.first_ts: datetime | None = None
        self.last_ts: datetime | None = None
        self.first_prompt_ts: datetime | None = None
        self.copied_ids: set[str] = set()
        self.own_ids: set[str] = set()
        self.own_first_ts: datetime | None = None
        self.marker_seen = False
        """Any message in the file carried a ``session_id`` marker (Claude Code 2.1.199 or later)."""
        self.marker: str | None = None
        """``own``, ``foreign`` or None for the message record being read."""
        self.producer: str | None = None
        """Session named by the marker of the record being read, when foreign."""
        self.producers: Counter[str] = Counter()
        """Foreign producers in order of first appearance; the last one is the direct predecessor."""
        self.inherited_last_ts: datetime | None = None
        self.uuid_ts: dict[str, datetime] = {}
        self.continued_in: list[tuple[str, datetime | None]] = []
        self.fork_ref: dict[str, Any] | None = None

    def claim(self, key: str) -> None:
        """Record that the marker of the current record owns or disowns an identifier."""
        if self.marker == "foreign":
            self.copied_ids.add(key)
        elif self.marker == "own":
            self.own_ids.add(key)

    def mark(self, record: dict[str, Any], ts: datetime | None) -> None:
        """Read the ``session_id`` marker of a message record."""
        self.marker = None
        self.producer = None
        producer = record.get("session_id")
        if not isinstance(producer, str):
            return
        self.marker_seen = True
        if producer == (self.parent or self.thread_id):
            self.marker = "own"
            if ts is not None and (self.own_first_ts is None or ts < self.own_first_ts):
                self.own_first_ts = ts
            return
        self.marker = "foreign"
        self.producer = producer
        self.producers[producer] += 1
        if ts is not None and (self.inherited_last_ts is None or ts > self.inherited_last_ts):
            self.inherited_last_ts = ts

    @property
    def turn(self) -> dict[str, Any] | None:
        return self.turns[-1] if self.turns else None

    def is_copied(self, turn_id: str | None, ts: datetime | None, key: str | None = None) -> bool:
        """Decide whether a line was copied from another session or a parent.

        A marker or ownership verdict on the identifier itself is decisive. Otherwise lines before
        the thread's own start are copies. A turn being inherited says nothing about its responses:
        a continued session answers the prompt it inherited with responses of its own.
        """
        if turn_id and turn_id.startswith("implicit-"):
            return True
        if key is not None:
            if key in self.copied_ids:
                return True
            if key in self.own_ids:
                return False
        boundary = self.own_start_hint()
        return boundary is not None and ts is not None and ts < boundary

    def own_start_hint(self) -> datetime | None:
        """When the thread's own messages begin: the first own marker, else the first prompt.

        A file with markers can still carry unmarked copies (record types that never got a
        marker), so its boundary is the first own-marked message, not the first prompt seen.
        """
        if self.marker_seen:
            return self.own_first_ts
        return self.first_prompt_ts

    def start_key(self) -> tuple[datetime, int]:
        """Sort key for ownership: earlier own start first, a session before its sub-agents."""
        started = self.own_start_hint() or self.first_ts or datetime.max
        return started, 1 if self.parent else 0

    def see(self, ts: datetime | None, *, activity: bool = True) -> None:
        """Track the thread's span and, for message records, extend the open turn."""
        if ts is None:
            return
        if self.first_ts is None or ts < self.first_ts:
            self.first_ts = ts
        if self.last_ts is None or ts > self.last_ts:
            self.last_ts = ts
        turn = self.turn
        if activity and turn is not None and (turn.get("last_ts") is None or ts > turn["last_ts"]):
            turn["last_ts"] = ts


class ClaudeIngest(BaseIngest):
    """One ingest of a Claude Code configuration directory into a fresh DuckDB file.

    Parameters
    ----------
    claude_dir : Path
        Claude configuration directory holding ``projects/``.
    db_path : Path
        DuckDB file to create; an existing file is replaced.
    window_days : int or None
        Sessions first seen before ``now - window_days`` are counted, not modelled. None disables.
    blobs : bool
        Store tool calls with their results and message blocks in ``item_blobs``.
    now : datetime or None
        Reference time for the window; defaults to the current UTC time.
    """

    def __init__(
        self,
        claude_dir: Path,
        db_path: Path,
        *,
        window_days: int | None = DEFAULT_WINDOW_DAYS,
        blobs: bool = True,
        now: datetime | None = None,
    ) -> None:
        super().__init__(SOURCE, "claude", claude_dir, db_path, window_days=window_days, blobs=blobs, now=now)
        self.threads: dict[str, _Thread] = {}
        self.owners: dict[str, str] = {}

    # ----------------------------------------------------------------- ingest
    def ingest(self) -> None:
        """Read every session and sub-agent file under ``projects/``."""
        started = time.perf_counter()
        projects = self.root / "projects"
        mains = sorted(projects.glob("*/*.jsonl")) if projects.is_dir() else []
        subs = sorted(projects.glob("*/*/subagents/**/*.jsonl")) if projects.is_dir() else []
        lines = 0
        skipped = 0
        for path in mains + subs:
            parent = path.relative_to(projects).parts[1] if "subagents" in path.relative_to(projects).parts else None
            count = self.session(path, parent)
            if count is None:
                skipped += 1
            else:
                lines += count
        self.phase(
            "sessions",
            started,
            lines,
            f"session files {len(mains)}; sub-agent files {len(subs)}; outside window {skipped}",
        )
        self.finish()

    # ---------------------------------------------------------------- session
    def session(self, path: Path, parent: str | None) -> int | None:
        """Read one session or sub-agent file; return its line count, or None when outside the window."""
        session_id = parent or path.stem
        agent_id = path.stem.removeprefix("agent-") if parent else None
        thread_id = f"{session_id}:{agent_id}" if parent else session_id
        anchor = self.anchor(path, session_id)
        cover = self.cover(thread_id)
        cover["rollout_format"] = FORMAT
        cover["in_window"] = self.in_window(anchor)
        thread = self.threads.setdefault(thread_id, _Thread(thread_id, parent=parent, path=path))
        thread.record["created_at"] = anchor
        thread.record["in_window"] = cover["in_window"]
        if parent:
            session_dir = next(p for p in path.parents if p.name == session_id)
            thread.record["agent_path"] = str(path.relative_to(session_dir).with_suffix(""))
            thread.record["agent_nickname"] = agent_id
        if not cover["in_window"]:
            cover["rollout_lines"] = None
            return None
        lines = 0
        with path.open("rb") as stream:
            for number, raw in enumerate(stream):
                lines += 1
                if raw.startswith(b'{"type":"api-request-blob"'):
                    self.ignored("api-request-blob")
                    continue
                try:
                    record = json.loads(raw)
                except ValueError:
                    cover["unknown_line_types"] += 1
                    self.unknown("unparseable")
                    continue
                self.line(thread, cover, record, number)
        cover["rollout_lines"] = lines
        self.close_turn(thread)
        return lines

    def anchor(self, path: Path, session_id: str) -> datetime:
        """Return when the session itself started, for the window decision.

        That is the timestamp of the first message the file did not inherit (no marker, or a
        marker naming this session), else the first timestamp in the file, else the modification
        time. A continued session carries its predecessor's old messages first, so the first
        timestamp alone would date it to its ancestor.
        """
        first: datetime | None = None
        with path.open("rb") as stream:
            for raw in stream:
                if b'"timestamp"' not in raw:
                    continue
                try:
                    record = json.loads(raw)
                except ValueError:
                    continue
                moment = schema.from_iso(record.get("timestamp"))
                if moment is None:
                    continue
                first = first or moment
                if record.get("type") in {"user", "assistant"}:
                    producer = record.get("session_id")
                    if producer is None or producer == session_id:
                        return moment
        if first is not None:
            return first
        return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).replace(tzinfo=None)

    # ------------------------------------------------------------------- line
    def line(self, thread: _Thread, cover: dict[str, Any], record: dict[str, Any], number: int) -> None:
        kind = record.get("type")
        ts = schema.from_iso(record.get("timestamp"))
        if record.get("isSidechain") and record.get("agentId") and thread.parent is None:
            # Older versions kept sub-agent lines inside the session file.
            child_id = f"{thread.thread_id}:{record['agentId']}"
            child = self.threads.get(child_id)
            if child is None:
                child = self.threads[child_id] = _Thread(child_id, parent=thread.thread_id, path=thread.path)
                child.record.update(created_at=ts, in_window=True, agent_path=f"agent-{record['agentId']}")
                child_cover = self.cover(child_id)
                child_cover["rollout_format"] = FORMAT
            thread, cover = child, self.cover(child_id)
        if kind != "continued-in":
            # A continued-in record is stamped when the successor starts, often days after the
            # last message here, so it neither ends the thread nor extends its last turn.
            thread.see(ts, activity=kind in {"user", "assistant", "attachment", "system"})
        self.describe_thread(thread, record)
        if kind in {"user", "assistant"}:
            thread.mark(record, ts)
            if isinstance(record.get("uuid"), str) and ts is not None:
                thread.uuid_ts[record["uuid"]] = ts
        if kind == "user":
            self.user(thread, cover, record, ts, number)
        elif kind == "assistant":
            self.assistant(thread, cover, record, ts, number)
        elif kind == "attachment":
            cover["response_items"] += 1
            rendered = record.get("rendered")
            text_len = len(rendered) if isinstance(rendered, str) else len(json.dumps(record.get("attachment") or {}))
            thread.response_items.append(
                schema.row(
                    "response_items",
                    thread_id=thread.thread_id,
                    turn_id=(thread.turn or {}).get("turn_id"),
                    ts=ts,
                    rollout_ordinal=number,
                    item_type="attachment",
                    role=record.get("renderedRole"),
                    text_len=text_len,
                    source=SOURCE,
                    origin="session-jsonl",
                )
            )
        elif kind == "system":
            self.system(thread, record, ts, number)
        elif kind == "cost-state":
            detail = {
                key: record.get(key)
                for key in (
                    "startTime",
                    "totalCostUSD",
                    "totalAPIDuration",
                    "totalAPIDurationWithoutRetries",
                    "totalToolDuration",
                    "totalLinesAdded",
                    "totalLinesRemoved",
                    "totalDuration",
                    "hasUnknownModelCost",
                    "modelUsage",
                )
            }
            self.event(thread, "cost-state", ts, number, detail)
        elif kind == "api-request":
            params = record.get("params") or {}
            detail = {
                "model": params.get("model"),
                "effort": (params.get("output_config") or {}).get("effort"),
                "max_tokens": params.get("max_tokens"),
                "cache_control_entries": len(record.get("cacheControl") or []),
                "query_source": record.get("querySource"),
            }
            self.event(thread, "api-request", ts, number, detail)
        elif kind == "fork-context-ref":
            parent_session = record.get("parentSessionId")
            if parent_session and parent_session != thread.thread_id:
                thread.record["forked_from_id"] = parent_session
            thread.fork_ref = record
            self.event(thread, "fork-context-ref", ts, number, {"context_length": record.get("contextLength")})
        elif kind == "continued-in":
            successor = record.get("continuedInSessionId")
            if isinstance(successor, str):
                thread.continued_in.append((successor, ts))
            self.event(thread, "continued-in", ts, number, {"session": successor})
        elif kind in {"ai-title", "custom-title"}:
            value = record.get("aiTitle") if kind == "ai-title" else record.get("customTitle")
            if isinstance(value, str):
                thread.titles[kind] = value
        elif kind in WORKFLOW_TYPES:
            detail = {key: record.get(key) for key in ("key", "label", "phase", "agentId") if key in record}
            self.event(thread, f"workflow:{kind}", ts, number, detail or None)
        elif kind in METADATA_TYPES:
            self.ignored(kind)
        else:
            cover["unknown_line_types"] += 1
            self.unknown(str(kind))

    def describe_thread(self, thread: _Thread, record: dict[str, Any]) -> None:
        record_fields = thread.record
        if record.get("cwd") and not record_fields.get("cwd"):
            record_fields["cwd"] = record["cwd"]
        if record.get("gitBranch") and not record_fields.get("git_branch"):
            record_fields["git_branch"] = record["gitBranch"]
        if record.get("version"):
            self.versions.add(str(record["version"]))
            if not record_fields.get("cli_version"):
                record_fields["cli_version"] = record["version"]
        if record.get("entrypoint") and not record_fields.get("originator"):
            record_fields["originator"] = record["entrypoint"]
        if record.get("sessionKind") and not record_fields.get("thread_source"):
            record_fields["thread_source"] = record["sessionKind"]

    # ------------------------------------------------------------------- user
    def user(self, thread: _Thread, cover: dict[str, Any], record: dict[str, Any], ts: Any, number: int) -> None:
        message = record.get("message") or {}
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        blocks = [block for block in blocks if isinstance(block, dict)]
        if record.get("isCompactSummary"):
            cover["compactions"] += 1
            text, _ = _block_text(content)
            self.event(thread, "compacted", ts, number, {"summary_len": len(text)})
            item_id = record.get("uuid") or f"compact-{number}"
            thread.claim(item_id)
            thread.items[item_id] = {
                "thread_id": thread.thread_id,
                "turn_id": (thread.turn or {}).get("turn_id"),
                "item_id": item_id,
                "rollout_ordinal": number,
                "item_type": "contextCompaction",
                "created_at": ts,
                "completed_at": ts,
                "status": "completed",
                "text_len": len(text),
                "item_json_bytes": len(text),
            }
            return
        results = [block for block in blocks if block.get("type") == "tool_result"]
        if results:
            for block in results:
                self.tool_result(thread, block, record, ts)
            return
        text, images = _block_text(content)
        if record.get("isMeta") or not (text or images):
            cover["response_items"] += 1
            thread.response_items.append(
                schema.row(
                    "response_items",
                    thread_id=thread.thread_id,
                    turn_id=(thread.turn or {}).get("turn_id"),
                    ts=ts,
                    rollout_ordinal=number,
                    item_type="user-meta",
                    role="user",
                    text_len=len(text),
                    source=SOURCE,
                    origin="session-jsonl",
                )
            )
            return
        if text.lstrip().startswith(("<command-name>", "<local-command-", "<command-message>")):
            cover["response_items"] += 1
            thread.response_items.append(
                schema.row(
                    "response_items",
                    thread_id=thread.thread_id,
                    turn_id=(thread.turn or {}).get("turn_id"),
                    ts=ts,
                    rollout_ordinal=number,
                    item_type="local-command",
                    role="user",
                    text_len=len(text),
                    source=SOURCE,
                    origin="session-jsonl",
                )
            )
            return
        self.close_turn(thread)
        turn_id = record.get("promptId") or record.get("uuid") or f"turn-{number}"
        if turn_id in thread.turn_ids:
            turn_id = f"{turn_id}:{number}"
        thread.turn_ids.add(turn_id)
        copied = thread.marker == "foreign"
        if copied:
            thread.copied_ids.add(turn_id)
        elif thread.first_prompt_ts is None:
            thread.first_prompt_ts = ts
        thread.turns.append(
            {
                "thread_id": thread.thread_id,
                "turn_id": turn_id,
                "root_turn_id": turn_id,
                "rollout_ordinal": number,
                "started_at": ts,
                "last_ts": ts,
                "first_assistant_ts": None,
                "cwd": record.get("cwd"),
                "stop_reason": None,
                "api_error": False,
                "duration_from_system": None,
                "responses": set(),
                "origin": COPIED if copied else "session-jsonl",
            }
        )
        cover["turn_contexts"] += 1
        item_id = record.get("uuid") or f"user-{number}"
        thread.claim(item_id)
        thread.items[item_id] = {
            "thread_id": thread.thread_id,
            "turn_id": turn_id,
            "item_id": item_id,
            "rollout_ordinal": number,
            "item_type": "userMessage",
            "created_at": ts,
            "completed_at": ts,
            "status": "completed",
            "text": text[:20000],
            "text_len": len(text),
            "image_count": images,
            "n_parts": len(blocks),
            "item_json_bytes": len(json.dumps(content)) if content is not None else 0,
        }
        if self.blobs:
            thread.blobs[item_id] = {"type": "userMessage", "content": content}

    # -------------------------------------------------------------- assistant
    def assistant(self, thread: _Thread, cover: dict[str, Any], record: dict[str, Any], ts: Any, number: int) -> None:
        message = record.get("message") or {}
        if thread.turn is None:
            thread.turns.append(
                {
                    "thread_id": thread.thread_id,
                    "turn_id": f"implicit-{record.get('uuid') or number}",
                    "root_turn_id": None,
                    "rollout_ordinal": number,
                    "started_at": ts,
                    "last_ts": ts,
                    "first_assistant_ts": None,
                    "cwd": record.get("cwd"),
                    "stop_reason": None,
                    "api_error": False,
                    "duration_from_system": None,
                    "responses": set(),
                    "origin": COPIED,
                }
            )
        turn = thread.turn
        assert turn is not None
        if turn["first_assistant_ts"] is None:
            turn["first_assistant_ts"] = ts
        model = message.get("model")
        effort = record.get("effort") or record.get("perTurnEffort")
        if isinstance(model, str):
            thread.models[model] += 1
            turn["model"] = model
        if isinstance(effort, str):
            thread.efforts[effort] += 1
            turn["reasoning_effort"] = effort
        if record.get("isApiErrorMessage") or record.get("apiErrorStatus"):
            turn["api_error"] = True
            self.event(
                thread,
                "api-error",
                ts,
                number,
                {"status": record.get("apiErrorStatus"), "error": str(record.get("error"))[:200]},
            )
        if message.get("stop_reason"):
            turn["stop_reason"] = message["stop_reason"]
        if record.get("isAbortedMidStream"):
            self.event(thread, "aborted-mid-stream", ts, number, {"model": model})
        response_id = message.get("id") or record.get("requestId") or record.get("uuid") or f"resp-{number}"
        thread.claim(response_id)
        response = thread.responses.get(response_id)
        if response is None:
            response = thread.responses[response_id] = {
                "response_id": response_id,
                "turn_id": turn["turn_id"],
                "ts": ts,
                "rollout_ordinal": number,
                "model": model,
                "usage": None,
                "producer": thread.producer,
            }
            cover["usage_records"] += 1
        usage = message.get("usage")
        if isinstance(usage, dict):
            # One API response is written as one record per content block. Sub-agent files put a
            # placeholder output count on earlier blocks and the real one on the last, and a fork copy
            # can carry a zero with the same timestamp, so keep the member with the most output.
            current = response.get("usage")
            if current is None or int(usage.get("output_tokens") or 0) >= int(current.get("output_tokens") or 0):
                response["usage"] = usage
        turn["responses"].add(response_id)
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for index, block in enumerate(blocks):
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            item_id = (
                f"{record.get('uuid') or number}:{index}" if kind != "tool_use" else block.get("id") or f"tool-{number}"
            )
            thread.claim(item_id)
            base = {
                "thread_id": thread.thread_id,
                "turn_id": turn["turn_id"],
                "item_id": item_id,
                "rollout_ordinal": number,
                "created_at": ts,
                "status": "completed",
                "cwd": record.get("cwd"),
                "item_json_bytes": len(json.dumps(block)),
            }
            if kind == "text":
                text = block.get("text") or ""
                base.update(
                    item_type="agentMessage",
                    completed_at=ts,
                    text=text[:20000],
                    text_len=len(text),
                    has_mermaid="```mermaid" in text,
                    image_count=text.count("!["),
                )
                thread.items[item_id] = base
                if self.blobs:
                    thread.blobs[item_id] = {"type": "agentMessage", "block": block}
            elif kind == "thinking":
                thinking = block.get("thinking") or ""
                base.update(
                    item_type="reasoning",
                    completed_at=ts,
                    text_len=len(thinking),
                    exec_duration_ms=record.get("thinkingDurationMs"),
                )
                thread.items[item_id] = base
            elif kind == "tool_use":
                base.update(self.tool_use(block, record))
                base.update(item_type=base.get("item_type"), started_at=ts, status="inProgress")
                thread.items[item_id] = base
                if self.blobs:
                    thread.blobs[item_id] = {"type": "toolCall", "call": block, "result": None, "toolUseResult": None}
            else:
                self.ignored(f"assistant:{kind}")

    def tool_use(self, block: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
        """Map one Claude ``tool_use`` block onto item columns."""
        name = block.get("name") or ""
        inputs = block.get("input") if isinstance(block.get("input"), dict) else {}
        out: dict[str, Any] = {"tool": name, "exec_source": "claude"}
        if name == "Bash":
            command = inputs.get("command") or ""
            out.update(
                item_type="commandExecution",
                command=command[:4000],
                command_program=item_columns.program(command),
                text=command[:20000],
                text_len=len(command),
                agent_kind="background" if inputs.get("run_in_background") else None,
            )
        elif name in EDIT_TOOLS:
            path = inputs.get("file_path") or inputs.get("notebook_path")
            added = deleted = 0
            if name == "Write":
                added = _lines(inputs.get("content"))
            elif name == "MultiEdit":
                for edit in inputs.get("edits") or []:
                    if isinstance(edit, dict):
                        added += _lines(edit.get("new_string"))
                        deleted += _lines(edit.get("old_string"))
            else:
                added = _lines(inputs.get("new_string") or inputs.get("new_source"))
                deleted = _lines(inputs.get("old_string"))
            out.update(
                item_type="fileChange",
                paths=json.dumps([path]),
                n_parts=1,
                added_lines=added,
                deleted_lines=deleted,
                text=path,
                text_len=len(path) if isinstance(path, str) else None,
            )
        elif name.startswith("mcp__"):
            parts = name.split("__", 2)
            server = parts[1] if len(parts) > 1 else None
            tool = parts[2] if len(parts) > 2 else name
            out.update(item_type="mcpToolCall", server=server, tool=tool, text=f"{server}:{tool}", text_len=len(name))
        elif name == "Agent":
            description = inputs.get("description") or inputs.get("prompt") or ""
            out.update(
                item_type="collabAgentToolCall",
                agent_kind=inputs.get("subagent_type") or "agent",
                agent_path=inputs.get("name"),
                text=description[:20000],
                text_len=len(description),
            )
        elif name in SEARCH_TOOLS:
            query = inputs.get("query") or inputs.get("url") or ""
            out.update(item_type="webSearch", text=query[:20000], text_len=len(query))
        else:
            summary = next((inputs.get(key) for key in SUMMARY_KEYS if isinstance(inputs.get(key), str)), None)
            out.update(item_type="toolCall", text=summary, text_len=len(summary) if summary else None)
        return out

    def tool_result(self, thread: _Thread, block: dict[str, Any], record: dict[str, Any], ts: Any) -> None:
        """Complete the item a ``tool_result`` block answers."""
        item = thread.items.get(block.get("tool_use_id") or "")
        structured = record.get("toolUseResult")
        if item is None:
            self.ignored("orphan-tool-result")
            return
        text, images = _block_text(block.get("content"))
        started = item.get("started_at")
        item["completed_at"] = ts
        if started is not None and ts is not None:
            item["duration_ms"] = int((ts - started).total_seconds() * 1000)
        item["status"] = "failed" if block.get("is_error") else "completed"
        item["output_bytes"] = len(text.encode())
        item["image_count"] = (item.get("image_count") or 0) + images
        if isinstance(structured, dict):
            if "stdout" in structured or "stderr" in structured:
                output = (structured.get("stdout") or "") + (structured.get("stderr") or "")
                item["output_bytes"] = len(output.encode())
                item["output_truncated"] = bool(structured.get("persistedOutputPath"))
                if structured.get("interrupted"):
                    item["status"] = "interrupted"
            counts = patch_line_counts(structured.get("structuredPatch"))
            if counts is not None and item.get("item_type") == "fileChange":
                item["added_lines"], item["deleted_lines"] = counts
        if item.get("item_type") == "mcpToolCall":
            item["mcp_error"] = bool(block.get("is_error"))
        if self.blobs and item["item_id"] in thread.blobs:
            blob = thread.blobs[item["item_id"]]
            blob["result"] = block
            blob["toolUseResult"] = structured

    # ----------------------------------------------------------------- system
    def system(self, thread: _Thread, record: dict[str, Any], ts: Any, number: int) -> None:
        subtype = record.get("subtype") or "unknown"
        detail = {
            key: record.get(key) for key in ("level", "durationMs", "messageCount", "compactMetadata") if key in record
        }
        if subtype == "turn_duration" and thread.turn is not None and record.get("durationMs") is not None:
            thread.turn["duration_from_system"] = record["durationMs"]
        self.event(thread, f"system:{subtype}", ts, number, detail)

    def event(self, thread: _Thread, kind: str, ts: Any, number: int, detail: dict[str, Any] | None) -> None:
        thread.events.append(
            schema.row(
                "rollout_events",
                thread_id=thread.thread_id,
                turn_id=(thread.turn or {}).get("turn_id"),
                ts=ts,
                rollout_ordinal=number,
                event_type=kind,
                detail=json.dumps(detail, default=str) if detail else None,
                source=SOURCE,
                origin="session-jsonl",
            )
        )

    def close_turn(self, thread: _Thread) -> None:
        """Finalize the open turn's status and timing."""
        turn = thread.turn
        if turn is None or turn.get("closed"):
            return
        turn["closed"] = True
        if turn["api_error"]:
            turn["status"] = "failed"
        elif turn["stop_reason"] in {"end_turn", "stop_sequence", "max_tokens"}:
            turn["status"] = "completed"
        elif turn["responses"]:
            turn["status"] = "interrupted"
        else:
            turn["status"] = "noResponse"
        started = turn.get("started_at")
        last = turn.get("last_ts")
        turn["completed_at"] = last
        if turn["duration_from_system"] is not None:
            turn["duration_ms"] = turn["duration_from_system"]
        elif started is not None and last is not None:
            turn["duration_ms"] = int((last - started).total_seconds() * 1000)
        first = turn.get("first_assistant_ts")
        if started is not None and first is not None:
            turn["time_to_first_token_ms"] = int((first - started).total_seconds() * 1000)

    # ----------------------------------------------------------------- finish
    def finish(self) -> None:
        started = time.perf_counter()
        thread_columns = dict(schema.COLUMNS["threads"])
        turn_columns = dict(schema.COLUMNS["turns"])
        item_columns_set = dict(schema.COLUMNS["items"])
        thread_rows: list[tuple] = []
        turn_rows: list[tuple] = []
        self.assign_owners()
        edges = self.fork_edges()
        for note in assign_lineage({thread_id: thread.record for thread_id, thread in self.threads.items()}).values():
            self.summary.notes.append(note)
        self.write("fork_edges", edges)
        for thread in self.threads.values():
            self.close_turn(thread)
            for turn in thread.turns:
                responses = turn["responses"]
                inherited_prompt = turn["turn_id"] in thread.copied_ids
                if responses:
                    copied_turn = all(
                        thread.is_copied(None, r.get("ts"), rid)
                        for rid, r in thread.responses.items()
                        if rid in responses
                    )
                else:
                    copied_turn = inherited_prompt
                turn["origin"] = COPIED if copied_turn else "session-jsonl"
            record = thread.record
            record.setdefault("in_window", True)
            own_start = self.own_start(thread)
            if own_start is not None:
                record["created_at"] = own_start
            record["updated_at"] = thread.last_ts
            record["title"] = thread.titles.get("custom-title") or thread.titles.get("ai-title")
            record["model"] = thread.models.most_common(1)[0][0] if thread.models else None
            record["reasoning_effort"] = thread.efforts.most_common(1)[0][0] if thread.efforts else None
            record["source"] = SOURCE
            if not record.get("in_window"):
                thread_rows.append(schema.row("threads", **{k: v for k, v in record.items() if k in thread_columns}))
                continue
            responses, counts = self.usage_rows(thread)
            record["tokens_used"] = sum(row[TOTAL_INDEX] for row in responses) if responses else 0
            thread_rows.append(schema.row("threads", **{k: v for k, v in record.items() if k in thread_columns}))
            for turn in thread.turns:
                turn_rows.append(
                    schema.row("turns", **{k: v for k, v in turn.items() if k in turn_columns}, source=SOURCE)
                )
            self.write("responses", responses)
            self.write("token_counts", counts)
            self.write(
                "items",
                [
                    schema.row(
                        "items",
                        **{k: v for k, v in item.items() if k in item_columns_set},
                        source=SOURCE,
                        origin=COPIED
                        if thread.is_copied(item.get("turn_id"), item.get("created_at"), item["item_id"])
                        else "session-jsonl",
                    )
                    for item in thread.items.values()
                ],
            )
            if self.blobs:
                self.write(
                    "item_blobs",
                    [
                        schema.row(
                            "item_blobs",
                            thread_id=thread.thread_id,
                            turn_id=thread.items[item_id]["turn_id"],
                            item_id=item_id,
                            item_json=json.dumps(blob, default=str),
                            source=SOURCE,
                            origin="session-jsonl",
                        )
                        for item_id, blob in thread.blobs.items()
                        if item_id in thread.items
                    ],
                )
            self.write("rollout_events", thread.events)
            self.write("response_items", thread.response_items)
            if thread.parent and thread.parent in self.threads:
                self.write(
                    "spawn_edges",
                    [
                        schema.row(
                            "spawn_edges",
                            parent_thread_id=thread.parent,
                            child_thread_id=thread.thread_id,
                            status="recorded",
                            source=SOURCE,
                            origin="session-jsonl",
                        )
                    ],
                )
        self.write("threads", thread_rows)
        self.write("turns", turn_rows)
        cover_rows = self.write_coverage_and_meta()
        self.phase(
            "finish",
            started,
            len(thread_rows) + len(turn_rows) + cover_rows,
            f"threads {len(thread_rows)}; turns {len(turn_rows)}; coverage {cover_rows}",
        )

    def assign_owners(self) -> None:
        """Mark response and item identifiers that another thread owns.

        A marker settles ownership outright. For identifiers without one (files written before
        2.1.199, sub-agent files), the earliest-started thread holding an id owns it and every later
        thread holding it has a copy. Sub-agents reuse their parent's prompt id for their own first
        turn, so turn ids never take part.
        """
        owners: dict[str, str] = {}
        for thread in self.threads.values():
            for key in thread.own_ids:
                owners.setdefault(key, thread.thread_id)
        for thread in sorted(self.threads.values(), key=lambda t: t.start_key()):
            for key in (*thread.responses, *thread.items):
                if key in thread.copied_ids or key in thread.own_ids:
                    continue
                owner = owners.setdefault(key, thread.thread_id)
                if owner != thread.thread_id:
                    thread.copied_ids.add(key)
        self.owners = owners

    def own_start(self, thread: _Thread) -> datetime | None:
        """Return when the thread produced its first own message, from markers or ownership."""
        if thread.own_first_ts is not None:
            return thread.own_first_ts
        moments = [r["ts"] for key, r in thread.responses.items() if key not in thread.copied_ids and r.get("ts")]
        moments += [
            item["created_at"]
            for key, item in thread.items.items()
            if key not in thread.copied_ids and item.get("created_at")
        ]
        return min(moments) if moments else None

    def fork_edges(self) -> list[tuple]:
        """Build ``fork_edges`` rows and set ``forked_from_id`` on continued sessions.

        A session's direct predecessor is the last foreign producer its markers name; a
        ``continued-in`` record in the predecessor confirms it or, when the successor's file is
        absent, stands alone. Files without markers that hold copies of another thread's messages get
        an edge to that thread by uuid overlap, flagged ambiguous because only start order picked
        the direction. Sub-agents with a ``fork-context-ref`` inherit by reference, so their edge
        carries the referenced length and the fork point in the parent's timeline.
        """
        rows: list[tuple] = []
        linked: dict[str, tuple[str, int]] = {}

        def edge(parent: str, child: str, **values: Any) -> None:
            linked[child] = (parent, len(rows))
            rows.append(
                schema.row(
                    "fork_edges",
                    parent_thread_id=parent,
                    child_thread_id=child,
                    source=SOURCE,
                    origin="session-jsonl",
                    **{"ambiguous": False, **values},
                )
            )

        for thread in self.threads.values():
            if thread.parent is not None:
                ref = thread.fork_ref
                if ref is not None:
                    parent_thread = self.threads.get(thread.parent)
                    fork_point = parent_thread.uuid_ts.get(str(ref.get("parentLastUuid"))) if parent_thread else None
                    edge(
                        thread.parent,
                        thread.thread_id,
                        kind="subagent-fork",
                        evidence="fork-context-ref",
                        inherited_records=ref.get("contextLength"),
                        fork_point_ts=fork_point,
                        child_started_at=thread.first_prompt_ts or thread.first_ts,
                    )
                continue
            if thread.producers:
                parent = list(thread.producers)[-1]
                thread.record["forked_from_id"] = parent
                edge(
                    parent,
                    thread.thread_id,
                    kind="continuation",
                    evidence="marker",
                    inherited_records=sum(thread.producers.values()),
                    fork_point_ts=thread.inherited_last_ts,
                    child_started_at=thread.own_first_ts,
                )
                continue
            if thread.marker_seen:
                # Unmarked copies inside a marked file fall before its own start; no edge needed.
                continue
            copied_owners = Counter(
                self.owners[key]
                for key in thread.copied_ids
                if key in self.owners and self.owners[key] != thread.thread_id
            )
            if copied_owners:
                parent, count = copied_owners.most_common(1)[0]
                thread.record["forked_from_id"] = parent
                copied_ts = [r["ts"] for key, r in thread.responses.items() if key in thread.copied_ids and r.get("ts")]
                edge(
                    parent,
                    thread.thread_id,
                    kind="continuation",
                    evidence="uuid-overlap",
                    ambiguous=True,
                    inherited_records=count,
                    fork_point_ts=max(copied_ts) if copied_ts else None,
                    child_started_at=self.own_start(thread),
                )
        for thread in self.threads.values():
            for successor, ts in thread.continued_in:
                link = linked.get(successor)
                if link is not None and link[0] == thread.thread_id:
                    row = rows[link[1]]
                    index = [name for name, _ in schema.COLUMNS["fork_edges"]].index("evidence")
                    rows[link[1]] = row[:index] + (f"{row[index]}+continued-in",) + row[index + 1 :]
                    continue
                child = self.threads.get(successor)
                edge(
                    thread.thread_id,
                    successor,
                    kind="continuation",
                    evidence="continued-in",
                    child_started_at=(child.own_first_ts or child.first_prompt_ts) if child else ts,
                )
                if child is not None and not child.record.get("forked_from_id"):
                    child.record["forked_from_id"] = thread.thread_id
        return rows

    def usage_rows(self, thread: _Thread) -> tuple[list[tuple], list[tuple]]:
        """Build ``responses`` and synthesized ``token_counts`` rows with running totals."""
        responses: list[tuple] = []
        counts: list[tuple] = []
        thread_totals = {"input": 0, "cached": 0, "cache_write": 0, "output": 0, "total": 0}
        turn_totals: dict[str, dict[str, int]] = {}
        for response in thread.responses.values():
            copied = thread.is_copied(response["turn_id"], response.get("ts"), response["response_id"])
            usage = response.get("usage") or {}
            cached = int(usage.get("cache_read_input_tokens") or 0)
            cache_write = int(usage.get("cache_creation_input_tokens") or 0)
            tiers = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
            cache_write_1h = int(tiers.get("ephemeral_1h_input_tokens") or 0)
            uncached = int(usage.get("input_tokens") or 0)
            output = int(usage.get("output_tokens") or 0)
            iterations = usage.get("iterations") if isinstance(usage.get("iterations"), list) else []
            attempts = sum(int((it or {}).get("output_tokens") or 0) for it in iterations if isinstance(it, dict))
            wasted = max(attempts - output, 0) if len(iterations) > 1 else 0
            total_input = uncached + cached + cache_write
            total = total_input + output
            turn = turn_totals.setdefault(response["turn_id"], {"input": 0, "cached": 0, "output": 0, "total": 0})
            if not copied:
                for bucket, value in (("input", total_input), ("cached", cached), ("output", output), ("total", total)):
                    thread_totals[bucket] += value
                    turn[bucket] += value
                thread_totals["cache_write"] += cache_write
                self.cover(thread.thread_id)["token_counts"] += 1
            responses.append(
                schema.row(
                    "responses",
                    thread_id=thread.thread_id,
                    turn_id=response["turn_id"],
                    root_turn_id=response["turn_id"],
                    session_id=response.get("producer") or thread.parent or thread.thread_id,
                    response_id=response["response_id"],
                    ts=response["ts"],
                    rollout_ordinal=response["rollout_ordinal"],
                    model=response.get("model"),
                    input_tokens=total_input,
                    cached_input_tokens=cached,
                    cache_write_input_tokens=cache_write,
                    cache_write_1h_input_tokens=cache_write_1h,
                    output_tokens=output,
                    reasoning_output_tokens=None,
                    wasted_output_tokens=wasted,
                    total_tokens=total,
                    turn_input_tokens=turn["input"],
                    turn_cached_input_tokens=turn["cached"],
                    turn_output_tokens=turn["output"],
                    turn_total_tokens=turn["total"],
                    thread_input_tokens=thread_totals["input"],
                    thread_cached_input_tokens=thread_totals["cached"],
                    thread_output_tokens=thread_totals["output"],
                    thread_total_tokens=thread_totals["total"],
                    source=SOURCE,
                    origin=COPIED if copied else "assistant",
                )
            )
            if copied:
                continue
            counts.append(
                schema.row(
                    "token_counts",
                    thread_id=thread.thread_id,
                    turn_id=response["turn_id"],
                    ts=response["ts"],
                    rollout_ordinal=response["rollout_ordinal"],
                    total_input_tokens=thread_totals["input"],
                    total_cached_input_tokens=thread_totals["cached"],
                    total_cache_write_input_tokens=thread_totals["cache_write"],
                    total_output_tokens=thread_totals["output"],
                    total_tokens=thread_totals["total"],
                    last_input_tokens=total_input,
                    last_cached_input_tokens=cached,
                    last_cache_write_input_tokens=cache_write,
                    last_output_tokens=output,
                    last_total_tokens=total,
                    source=SOURCE,
                    origin="assistant",
                )
            )
        return responses, counts


def ingest_claude_dir(
    claude_dir: Path | None = None,
    db_path: Path | None = None,
    *,
    window_days: int | None = DEFAULT_WINDOW_DAYS,
    blobs: bool = True,
    now: datetime | None = None,
) -> IngestSummary:
    """Ingest a Claude Code configuration directory into a DuckDB file.

    Parameters
    ----------
    claude_dir : Path or None
        Configuration directory; defaults to ``$CLAUDE_CONFIG_DIR`` or ``~/.claude``.
    db_path : Path or None
        Target DuckDB file; defaults to ``claude-history.duckdb`` in the current directory.
    window_days : int or None
        Support window in days; None ingests everything.
    blobs : bool
        Store tool calls with results and message blocks in ``item_blobs``.
    now : datetime or None
        Reference time for the window, for tests.

    Returns
    -------
    IngestSummary
        Phase timings, row counts and notes.
    """
    ingest = ClaudeIngest(
        claude_dir or default_claude_dir(),
        db_path or Path("claude-history.duckdb"),
        window_days=window_days,
        blobs=blobs,
        now=now,
    )
    return ingest.run()
