"""Read one copied Claude family through official SDK history helpers, with no inference.

Run from the repository root with its uv environment::

    uv run python experiments/spikes/058-native-history-access/collect_claude_family.py \
        --session-file /path/to/.claude/projects/project/session.jsonl \
        --root /path/to/.claude --output experiments/artifacts/058-native-history-access/families/claude-run

The original parent and all descendant transcript/metadata files are copied without
rewriting their layout. Only the isolated subprocess imports/calls the SDK. The
result is a temporary study envelope, not an ingestion schema or native session.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import typer

app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)


def save(path: Path, value: Any) -> None:
    """Write local evidence without printing native contents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, default=serialize, ensure_ascii=False, indent=2) + "\n")


def serialize(value: Any) -> Any:
    """Keep SDK dataclass fields as returned by the public history helpers."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    raise TypeError(type(value).__name__)


def digest(path: Path) -> str:
    """Hash one original or copied history file."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def content_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Read documented API message content, without parsing native storage files."""
    raw = message.get("message")
    content = raw.get("content") if isinstance(raw, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def tool_index(messages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Associate API tool-use and result blocks by native tool_use_id."""
    result: dict[str, dict[str, Any]] = {}
    for message in messages:
        for block in content_blocks(message):
            if block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                inputs = block.get("input") if isinstance(block.get("input"), dict) else {}
                result.setdefault(block["id"], {}).update(
                    callMessageId=message.get("uuid"),
                    name=block.get("name"),
                    inputFields=sorted(inputs),
                    runInBackground=inputs.get("run_in_background"),
                    timeoutInput=inputs.get("timeout"),
                )
            elif block.get("type") == "tool_result" and isinstance(block.get("tool_use_id"), str):
                result.setdefault(block["tool_use_id"], {}).update(
                    resultMessageId=message.get("uuid"), isError=block.get("is_error", False)
                )
    return result


def timing_fields(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Count structured timing fields; do not mine timing claims from prose."""
    fields: Counter[str] = Counter()

    def walk(value: Any, path: str = "") -> None:
        if isinstance(value, dict):
            for key, entry in value.items():
                child = f"{path}.{key}" if path else key
                if any(
                    token in key.lower() for token in ("timestamp", "duration", "elapsed", "started_at", "completed_at")
                ):
                    fields[child] += 1
                # Content dictionaries may contain structured fields, but text/data
                # strings are never interpreted as timing records.
                if isinstance(entry, (dict, list)):
                    walk(entry, child)
        elif isinstance(value, list):
            for entry in value:
                walk(entry, f"{path}[]")

    for message in messages:
        walk(message)
    return {
        "messages": len(messages),
        "wrapperTimestamps": sum(message.get("timestamp") is not None for message in messages),
        "structuredTimingFieldCounts": dict(fields),
        "executionDuration": "not derived",
        "backgroundLifetime": "not derived",
        "callResultInterval": "unavailable without source timestamps",
    }


def worker(session_id: str, output: Path) -> None:
    """Use only public read APIs in the empty-home helper process."""
    network_attempts = 0

    def no_connect(*_args: Any, **_kwargs: Any) -> None:
        nonlocal network_attempts
        network_attempts += 1
        raise RuntimeError("Network is disabled in the read-only family collector")

    socket.socket.connect = no_connect  # type: ignore[assignment]
    socket.socket.connect_ex = no_connect  # type: ignore[assignment]
    socket.create_connection = no_connect  # type: ignore[assignment]
    from claude_agent_sdk import get_session_info, get_session_messages, get_subagent_messages, list_subagents

    calls: list[dict[str, Any]] = []

    def read(name: str, function: Any, **kwargs: Any) -> Any:
        start = time.perf_counter()
        value = function(**kwargs)
        calls.append(
            {
                "method": name,
                "elapsedMs": round((time.perf_counter() - start) * 1000, 3),
                "elapsedMeaning": "local history reader call latency; not agent/tool execution",
            }
        )
        return json.loads(json.dumps(value, default=serialize))

    captured = datetime.now(timezone.utc).isoformat()
    info = read("get_session_info", get_session_info, session_id=session_id)
    main = read("get_session_messages", get_session_messages, session_id=session_id)
    agent_ids = read("list_subagents", list_subagents, session_id=session_id)
    root_key = f"claude-family-{session_id}"
    source_base = {
        "kind": "native-api",
        "corpus": "family",
        "capturedAt": captured,
        "version": importlib.metadata.version("claude-agent-sdk"),
        "readOnly": True,
        "coverage": {
            "scope": "SDK visible chains from copied parent and recursive subagents tree",
            "timing": "No wrapper timestamps; no tool/background duration inferred",
        },
    }
    main_document = {
        "version": 1,
        "key": root_key,
        "provider": "claude",
        "sessionId": session_id,
        "title": (info or {}).get("custom_title") or (info or {}).get("summary") or "Claude family root",
        "source": {
            **source_base,
            "method": "get_session_info + get_session_messages",
            "relation": {"kind": "root", "rootSessionId": session_id},
        },
        "payload": {"info": info, "messages": main},
    }
    save(output / "documents" / f"{root_key}.json", main_document)
    documents = {"root": main}
    child_documents: list[dict[str, Any]] = []
    members = [{"key": root_key, "kind": "root", "sessionId": session_id, "messages": len(main)}]
    edges = []
    empty = []
    duplicate_ids = [key for key, count in Counter(agent_ids).items() if count > 1]
    for agent_id in dict.fromkeys(agent_ids):
        messages = read("get_subagent_messages", get_subagent_messages, session_id=session_id, agent_id=agent_id)
        documents[agent_id] = messages
        parent_tools = sorted(
            {message["parent_tool_use_id"] for message in messages if message.get("parent_tool_use_id")}
        )
        parent_agents = sorted({message["parent_agent_id"] for message in messages if message.get("parent_agent_id")})
        relation = {
            "kind": "subagent",
            "rootSessionId": session_id,
            "agentId": agent_id,
            "parentToolUseIds": parent_tools,
            "parentAgentIds": parent_agents,
            "metadataConsistent": len(parent_tools) <= 1 and len(parent_agents) <= 1,
            "parentIdentityAvailable": len(parent_tools) == 1,
        }
        key = f"{root_key}-agent-{agent_id}"
        document = {
            "version": 1,
            "key": key,
            "provider": "claude",
            "sessionId": session_id,
            "title": f"Claude subagent {agent_id}",
            "source": {**source_base, "method": "get_subagent_messages", "relation": relation},
            "payload": {"info": None, "messages": messages},
        }
        child_documents.append(document)
        members.append({"key": key, **relation, "messages": len(messages)})
        if not messages:
            empty.append(agent_id)
        edges.append(relation)
    tool_maps = {agent: tool_index(messages) for agent, messages in documents.items()}
    for edge in edges:
        caller = edge["parentAgentIds"][0] if len(edge["parentAgentIds"]) == 1 else "root"
        tool = edge["parentToolUseIds"][0] if len(edge["parentToolUseIds"]) == 1 else None
        pair = tool_maps.get(caller, {}).get(tool, {})
        resolution = (
            "sdk-parent-agent"
            if len(edge["parentAgentIds"]) == 1
            else "matched-native-parent-tool"
            if pair.get("callMessageId")
            else "main-or-unknown"
        )
        edge.update(
            candidateParent=caller,
            parentResolution=resolution,
            parentDocumentAvailable=(caller in documents) if resolution != "main-or-unknown" else None,
            parentCallVisible=bool(pair.get("callMessageId")),
            parentResultVisible=bool(pair.get("resultMessageId")),
            parentCallName=pair.get("name"),
        )
    for document in child_documents:
        # The relation object is shared with edges; raw SDK messages remain unchanged.
        save(output / "documents" / f"{document['key']}.json", document)
    for member in members[1:]:
        member.update(next(edge for edge in edges if edge["agentId"] == member["agentId"]))
    page_size = 7
    main_page = read("get_session_messages", get_session_messages, session_id=session_id, offset=3, limit=page_size)
    child = next((agent for agent in documents if agent != "root" and documents[agent]), None)
    child_page = (
        read(
            "get_subagent_messages",
            get_subagent_messages,
            session_id=session_id,
            agent_id=child,
            offset=2,
            limit=page_size,
        )
        if child
        else []
    )
    after_ids = read("list_subagents", list_subagents, session_id=session_id)
    timing = {agent: timing_fields(messages) for agent, messages in documents.items()}
    save(
        output / "family.json",
        {
            "version": 1,
            "rootKey": root_key,
            "rootSessionId": session_id,
            "members": members,
            "edges": edges,
            "listedAgentIds": agent_ids,
            "completeness": {
                "meaning": "Every SDK-listed agent ID under the copied recursive subagents tree was read",
                "allListedRead": set(agent_ids) == set(documents) - {"root"},
                "duplicateAgentIds": duplicate_ids,
                "emptyAgentIds": empty,
                "missingParentIdentity": sum(not edge["parentIdentityAvailable"] for edge in edges),
                "missingParentCalls": sum(not edge["parentCallVisible"] for edge in edges),
                "missingParentResults": sum(not edge["parentResultVisible"] for edge in edges),
                "notEstablished": [
                    "All historically launched agents retained on disk",
                    "All pre-compaction/alternative main-chain records",
                    "Process liveness, task completion, or filesystem recovery",
                ],
            },
        },
    )
    save(output / "tool-links.json", {"byAgent": tool_maps})
    save(output / "timing.json", timing)
    save(
        output / "reader-evidence.json",
        {
            "sdkVersion": importlib.metadata.version("claude-agent-sdk"),
            "pythonVersion": platform.python_version(),
            "capturedAt": captured,
            "calls": calls,
            "networkAttempts": network_attempts,
            "providerCalls": 0,
            "inferenceUsd": 0,
            "mainPageMatches": main_page == main[3 : 3 + page_size],
            "childPageMatches": child_page == documents.get(child, [])[2 : 2 + page_size],
            "pagingMeaning": "SDK filters/reconstructs the full chain before offset/limit; native source inspected",
            "subagentListingUnchanged": agent_ids == after_ids,
            "mainMessages": len(main),
            "subagents": len(set(agent_ids)),
            "childMessages": sum(len(value) for key, value in documents.items() if key != "root"),
            "nestedParentLinks": sum(bool(edge["parentAgentIds"]) for edge in edges),
            "backgroundCallCount": sum(
                pair.get("runInBackground") is True for tools in tool_maps.values() for pair in tools.values()
            ),
            "toolNames": dict(
                Counter(pair.get("name") for tools in tool_maps.values() for pair in tools.values() if pair.get("name"))
            ),
        },
    )


def collect(root: Path, session_file: Path, output: Path) -> dict[str, Any]:
    """Copy a selected family, run the isolated reader, and verify source hygiene."""
    root = root.expanduser().resolve()
    session_file = session_file.expanduser().absolute()
    output = output.expanduser().resolve()
    relative = session_file.relative_to(root)
    if (
        session_file.is_symlink()
        or not session_file.is_file()
        or session_file.suffix != ".jsonl"
        or relative.parts[0] != "projects"
    ):
        raise ValueError("Choose a real transcript file under this Claude root's projects directory")
    if output.is_relative_to(root):
        raise ValueError("Write the export outside the original Claude root")
    if output.exists():
        raise ValueError("Use a new output directory; existing family exports are never overwritten")
    output.mkdir(parents=True)
    descendants = session_file.with_suffix("") / "subagents"
    files = [session_file] + sorted(
        path
        for path in descendants.rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and (path.name.startswith("agent-") and (path.name.endswith(".jsonl") or path.name.endswith(".meta.json")))
    )
    before = {str(path.relative_to(root)): digest(path) for path in files}
    try:
        with tempfile.TemporaryDirectory(prefix="pdum-claude-family-") as temporary:
            home = Path(temporary) / "home"
            copied = Path(temporary) / "claude"
            home.mkdir()
            for path in files:
                destination = copied / path.relative_to(root)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
            copied_before = {name: digest(copied / name) for name in before}
            environment = {
                "HOME": str(home),
                "CLAUDE_CONFIG_DIR": str(copied),
                "PATH": os.defpath,
                "LANG": "en_US.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            started = time.perf_counter()
            process = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(Path(__file__).resolve()),
                    "--worker",
                    session_file.stem,
                    str(output.resolve()),
                ],
                cwd=home,
                env=environment,
                capture_output=True,
                text=True,
                timeout=120,
            )
            save(
                output / "helper.json",
                {
                    "returncode": process.returncode,
                    "reaped": True,
                    "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
                    "environmentKeys": sorted(environment),
                },
            )
            (output / "helper.stderr.txt").write_text(process.stderr)
            copied_after = {name: digest(copied / name) for name in before}
            if process.returncode:
                raise RuntimeError("Isolated history helper failed; private stderr is in the run directory")
        after = {str(path.relative_to(root)): digest(path) for path in files}
        evidence = {
            "sourceRoot": str(root),
            "selectedParent": str(session_file),
            "files": len(files),
            "transcriptFiles": sum(path.suffix == ".jsonl" for path in files),
            "sidecarFiles": sum(path.name.endswith(".meta.json") for path in files),
            "sourceHashesBefore": before,
            "sourceHashesAfter": after,
            "sourceUnchanged": before == after,
            "copyMatchesSource": copied_before == before,
            "copyUnchanged": copied_after == copied_before,
            "temporaryHomeRemoved": not home.exists(),
        }
        save(output / "source-evidence.json", evidence)
        if not all(evidence[key] for key in ("sourceUnchanged", "copyMatchesSource", "copyUnchanged")):
            raise RuntimeError("Source or copied history changed during the read; inspect local evidence")
        reader = json.loads((output / "reader-evidence.json").read_text())
        return {
            "files": len(files),
            "mainMessages": reader["mainMessages"],
            "subagents": reader["subagents"],
            "childMessages": reader["childMessages"],
            "nestedParentLinks": reader["nestedParentLinks"],
            "backgroundCallCount": reader["backgroundCallCount"],
            "networkAttempts": reader["networkAttempts"],
            "sourceUnchanged": True,
            "copyUnchanged": True,
            "helperReaped": True,
        }
    except BaseException:
        save(
            output / "failed-source-evidence.json",
            {
                "sourceHashesBefore": before,
                "sourceHashesAfter": {str(path.relative_to(root)): digest(path) for path in files if path.exists()},
            },
        )
        raise


@app.command()
def main(
    root: Path = typer.Option(...), session_file: Path = typer.Option(...), output: Path = typer.Option(...)
) -> None:
    """Export one complete SDK-discoverable family into a new local run directory."""
    print(json.dumps(collect(root, session_file, output), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        worker(sys.argv[2], Path(sys.argv[3]))
    else:
        app()
