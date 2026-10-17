"""Column extraction from one Codex v2 ``ThreadItem`` JSON object.

The same function serves the SQLite projection, ``thread/items/list`` pages and live
``item/completed`` notifications, because all three carry the camelCase v2 shape.
"""

from __future__ import annotations

import json
import shlex
from typing import Any

OUTPUT_CAP = 64 * 1024
"""Codex truncates persisted ``aggregatedOutput`` at this size."""

SHELLS = {"bash", "sh", "zsh"}
WRAPPERS = {"sudo", "env", "time", "nice", "command"}


def diff_line_counts(diff: str) -> tuple[int, int]:
    """Count added and deleted lines the way Codex's accepted-line analytics does.

    Parameters
    ----------
    diff : str
        Unified diff text.

    Returns
    -------
    tuple of int
        ``(added, deleted)`` counting only lines inside hunks.
    """
    in_hunk = False
    added = deleted = 0
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            continue
        if line.startswith("@@ "):
            in_hunk = True
            continue
        if not in_hunk and (line.startswith("+++ ") or line.startswith("--- ")):
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            deleted += 1
    return added, deleted


def program(command: str) -> str | None:
    """Return the program a command runs, unwrapping ``/bin/zsh -lc`` and similar wrappers.

    Parameters
    ----------
    command : str
        Command text as recorded by Codex.

    Returns
    -------
    str or None
        The first word after unwrapping, or None for an empty command.
    """
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.split()
    if not parts:
        return None
    first = parts[0].rsplit("/", 1)[-1]
    if first in SHELLS and len(parts) >= 3 and parts[1].startswith("-") and "c" in parts[1]:
        inner = parts[2].strip()
        return program(inner) if inner else first[:64]
    if first in WRAPPERS and len(parts) >= 2:
        return program(" ".join(parts[1:]))
    return first[:64]


def extract(item: dict[str, Any]) -> dict[str, Any]:
    """Return ``items`` columns for one item.

    Parameters
    ----------
    item : dict
        A v2 ``ThreadItem`` object.

    Returns
    -------
    dict
        Column values keyed by :data:`pdum.agent_history.schema.COLUMNS` names for ``items``.
    """
    kind = item.get("type")
    out: dict[str, Any] = {"item_type": kind, "item_id": item.get("id"), "status": item.get("status")}
    text: str | None = None
    if kind == "commandExecution":
        command = item.get("command") or ""
        output = item.get("aggregatedOutput")
        actions = item.get("commandActions") or []
        output_bytes = len(output.encode()) if isinstance(output, str) else None
        out.update(
            command=command[:4000],
            command_program=program(command),
            command_action=(actions[0] or {}).get("type") if actions else None,
            cwd=item.get("cwd"),
            process_id=item.get("processId"),
            exec_source=item.get("source"),
            exit_code=item.get("exitCode"),
            exec_duration_ms=item.get("durationMs"),
            output_bytes=output_bytes,
            output_truncated=(output_bytes >= OUTPUT_CAP) if output_bytes is not None else None,
            n_parts=len(actions),
        )
        text = command
    elif kind == "mcpToolCall":
        result = item.get("result") or {}
        content = result.get("content") if isinstance(result, dict) else None
        out.update(
            server=item.get("server"),
            tool=item.get("tool"),
            exec_duration_ms=item.get("durationMs"),
            mcp_error=item.get("error") is not None,
            n_parts=len(content) if isinstance(content, list) else None,
        )
        text = f"{item.get('server')}:{item.get('tool')}"
    elif kind == "fileChange":
        changes = item.get("changes") or []
        added = deleted = 0
        for change in changes:
            more_added, more_deleted = diff_line_counts(change.get("diff") or "")
            added += more_added
            deleted += more_deleted
        out.update(
            n_parts=len(changes),
            added_lines=added,
            deleted_lines=deleted,
            paths=json.dumps([change.get("path") for change in changes]),
        )
    elif kind == "agentMessage":
        text = item.get("text") or ""
        out.update(has_mermaid="```mermaid" in text, image_count=text.count("!["), agent_kind=item.get("phase"))
    elif kind == "reasoning":
        summary = item.get("summary") or []
        text = "\n".join(part if isinstance(part, str) else json.dumps(part) for part in summary)
        out.update(n_parts=len(summary))
    elif kind == "userMessage":
        parts = item.get("content") or []
        texts = [part.get("text") for part in parts if isinstance(part, dict) and part.get("type") == "text"]
        images = sum(1 for part in parts if isinstance(part, dict) and part.get("type") in {"image", "localImage"})
        text = "\n".join(part for part in texts if isinstance(part, str))
        out.update(n_parts=len(parts), image_count=images)
    elif kind == "webSearch":
        text = item.get("query")
        results = item.get("results") or []
        out.update(n_parts=len(results) if isinstance(results, list) else None)
    elif kind == "subAgentActivity":
        out.update(
            agent_kind=item.get("kind"), agent_thread_id=item.get("agentThreadId"), agent_path=item.get("agentPath")
        )
    elif kind == "collabAgentToolCall":
        receivers = item.get("receiverThreadIds") or []
        out.update(
            agent_kind=item.get("tool"),
            agent_thread_id=receivers[0] if receivers else None,
            n_parts=len(receivers),
            tool=item.get("tool"),
        )
        text = item.get("prompt")
    elif kind == "imageView":
        text = item.get("path")
    elif kind == "sleep":
        out.update(exec_duration_ms=item.get("durationMs"))
    if text is not None:
        out["text"] = text[:20000]
        out["text_len"] = len(text)
    return out
