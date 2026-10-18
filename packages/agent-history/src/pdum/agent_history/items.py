"""Column extraction from one Codex v2 ``ThreadItem`` JSON object.

The same function serves the SQLite projection, ``thread/items/list`` pages and live
``item/completed`` notifications, because all three carry the camelCase v2 shape. Rollout
``item_completed`` events carry the core's own shape instead (PascalCase or snake_case type,
snake_case fields); :func:`normalize_core_item` turns that into the v2 shape first.
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


def _camel(name: str) -> str:
    if "_" in name:
        head, *rest = name.split("_")
        return head.lower() + "".join(part.capitalize() for part in rest)
    return name[:1].lower() + name[1:]


def _duration_ms(item: dict[str, Any]) -> int | None:
    duration = item.get("duration")
    if isinstance(duration, dict):
        return int(duration.get("secs") or 0) * 1000 + int(duration.get("nanos") or 0) // 1_000_000
    value = item.get("duration_ms", item.get("durationMs"))
    return int(value) if isinstance(value, (int, float)) else None


def normalize_core_item(item: dict[str, Any]) -> dict[str, Any]:
    """Return the camelCase v2 shape of an item recorded by a rollout ``item_completed`` event.

    Parameters
    ----------
    item : dict
        The core's item object: a PascalCase or snake_case ``type`` and snake_case fields such as
        ``process_id``, ``aggregated_output``, ``exit_code``, a ``duration`` with ``secs`` and
        ``nanos``, a ``command`` list, a ``file://`` working directory and ``changes`` keyed by path.

    Returns
    -------
    dict
        An object :func:`extract` understands. Fields with no v2 counterpart keep a camelCase name.
    """
    kind = _camel(str(item.get("type") or ""))
    out: dict[str, Any] = {"type": kind, "id": item.get("id"), "status": item.get("status")}
    if kind == "commandExecution":
        command = item.get("command")
        if isinstance(command, list):
            command = shlex.join(str(part) for part in command)
        cwd = item.get("cwd")
        if isinstance(cwd, str) and cwd.startswith("file://"):
            cwd = cwd[len("file://") :]
        out.update(
            command=command,
            cwd=cwd,
            processId=item.get("process_id", item.get("processId")),
            source=item.get("source"),
            aggregatedOutput=item.get("aggregated_output", item.get("aggregatedOutput")),
            exitCode=item.get("exit_code", item.get("exitCode")),
            durationMs=_duration_ms(item),
            commandActions=item.get("parsed_cmd") or item.get("commandActions") or [],
        )
    elif kind == "fileChange":
        changes = item.get("changes")
        if isinstance(changes, dict):
            listed = []
            for path, change in changes.items():
                change = change if isinstance(change, dict) else {}
                diff = change.get("diff")
                if diff is None:
                    sign = "-" if change.get("type") == "delete" else "+"
                    body = "\n".join(sign + line for line in str(change.get("content") or "").splitlines())
                    diff = f"@@ -0,0 +1 @@\n{body}" if body else ""
                listed.append({"path": path, "kind": change.get("type"), "diff": diff})
            changes = listed
        out["changes"] = changes or []
    elif kind == "agentMessage":
        content = item.get("content")
        if isinstance(content, list):
            text = "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
        else:
            text = str(item.get("text") or "")
        out.update(text=text, phase=item.get("phase"))
    elif kind == "reasoning":
        out["summary"] = item.get("summary_text") or item.get("summary") or []
    elif kind == "userMessage":
        out["content"] = item.get("content") or []
    elif kind == "mcpToolCall":
        out.update(
            server=item.get("server"),
            tool=item.get("tool"),
            durationMs=_duration_ms(item),
            result=item.get("result"),
            error=item.get("error"),
        )
    else:
        for key, value in item.items():
            out.setdefault(_camel(key), value)
    return out
