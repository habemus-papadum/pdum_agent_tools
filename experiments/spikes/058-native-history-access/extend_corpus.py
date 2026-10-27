"""Append explicitly selected everyday histories through native read APIs.

The private selection file names source transcript files, IDs and workspaces.
Only selected files and Codex's native projection are copied. Original homes
are never passed to a provider process. No configuration or credentials are
copied, and the shared reader rejects execution/lifecycle methods.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import typer
from export_history import Reader, save
from pdum.claude_launcher.profiles import Profile
from pdum.claude_launcher.storage import History

app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)


def digest(path: Path) -> str:
    """Hash a selected transcript, without printing its contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def has_prose_math(text: str) -> bool:
    """Recognize a qualified TeX example, excluding code and imported tool wrappers.

    This is a conservative corpus-selection aid, not a complete Markdown parser
    or a count of every mathematical expression. Shell dollar variables and
    literal delimiters in implementation discussions do not establish math.
    """
    if text.lstrip().startswith("[external_agent_"):
        return False
    prose = re.sub(r"```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~", "", text)
    prose = re.sub(r"`[^`\n]*`", "", prose)
    expressions = re.findall(
        r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<!\$)\$(?!\$)([^\n$]+)\$(?!\$)|\\\((.+?)\\\)", prose
    )
    tex = re.compile(
        r"\\(?:frac|sqrt|sum|int|prod|begin|alpha|beta|gamma|theta|phi|sigma|lambda|epsilon|mathrm|mathbf|"
        r"mathbb|operatorname|partial|nabla|infty|cdot|times|hat|widehat|underbrace|overbrace)(?![A-Za-z])"
    )
    return any(tex.search(expression) for group in expressions for expression in group)


def audit(document: dict[str, Any]) -> dict[str, Any]:
    """Describe returned native evidence; never reconstruct omitted records."""
    provider = document["provider"]
    payload = document["payload"]
    if provider == "codex":
        turns = payload["thread"].get("turns", [])
        items = [item for turn in turns for item in turn.get("items", [])]
    else:
        turns = []
        items = payload["messages"]
    counts: Counter[str] = Counter()
    phases: Counter[str] = Counter()
    keys: Counter[str] = Counter()

    def walk(value: Any, *, role: str = "unknown", tool_result: bool = False) -> None:
        if isinstance(value, list):
            for part in value:
                walk(part, role=role, tool_result=tool_result)
        elif isinstance(value, dict):
            kind = value.get("type", "")
            current_role = value.get("role", role)
            result = tool_result or kind in ("tool_result", "mcpToolCall", "dynamicToolCall")
            if kind == "userMessage":
                current_role = "user"
            if kind in ("agentMessage", "imageGeneration"):
                current_role = "assistant"
            if kind in ("image", "localImage", "input_image", "output_image", "imageGeneration"):
                origin = "tool-result" if result else current_role
                counts[f"image:{origin}"] += 1
                source = value.get("source") or {}
                url = value.get("url") or value.get("image_url") or ""
                if (
                    source.get("type") == "base64"
                    or (isinstance(url, str) and url.startswith("data:image/"))
                    or (value.get("mimeType", "").startswith("image/") and isinstance(value.get("data"), str))
                ):
                    counts["embedded-images"] += 1
                else:
                    counts["referenced-images"] += 1
            if kind in ("text", "input_text", "output_text", "agentMessage"):
                text = value.get("text", "")
                if "```mermaid" in text:
                    counts["mermaid"] += 1
                if "$$" in text or "\\[" in text or "\\(" in text:
                    counts["math-markers"] += 1
                if current_role == "assistant" and not result and has_prose_math(text):
                    counts["math-in-prose"] += 1
            if value.get("phase"):
                phases[str(value["phase"])] += 1
            if value.get("usage"):
                counts["usage-records"] += 1
            if kind in ("commandExecution", "tool_use", "dynamicToolCall", "mcpToolCall"):
                counts["tools"] += 1
            if kind in ("contextCompaction", "compact_boundary"):
                counts["compaction"] += 1
            for key, part in value.items():
                if any(word in key.lower() for word in ("token", "cost", "context", "cache")):
                    keys[key] += 1
                if isinstance(part, (list, dict)):
                    walk(part, role=current_role, tool_result=result)

    walk(items)
    return {
        "items": len(items),
        "turns": len(turns) if provider == "codex" else None,
        "bytes": len(json.dumps(payload, ensure_ascii=False).encode()),
        "features": sorted(name for name, count in counts.items() if count),
        "featureCounts": dict(counts),
        "phases": dict(phases),
        "metricFieldCounts": dict(keys),
    }


def capture_referenced_assets(document: dict[str, Any], output: Path) -> None:
    """Copy existing native image references; do not claim historical byte equality.

    Only explicitly typed localImage/imageView paths are considered. Ordinary
    code/tool paths are never interpreted as files to expose. Native payloads
    remain unchanged and the copy's retrieval evidence lives in a sidecar.
    """
    references: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            if value.get("type") in ("localImage", "imageView") and isinstance(value.get("path"), str):
                references.add(value["path"])
            for item in value.values():
                if isinstance(item, (dict, list)):
                    visit(item)

    visit(document["payload"])
    assets = []
    for reference in sorted(references):
        path = Path(reference)
        if not path.is_absolute() or not path.is_file():
            assets.append({"reference": reference, "kind": "unavailable", "reason": "reference unavailable at export"})
            continue
        data = path.read_bytes()
        suffix = (
            ".png"
            if data.startswith(b"\x89PNG\r\n\x1a\n")
            else ".jpg"
            if data.startswith(b"\xff\xd8\xff")
            else ".gif"
            if data.startswith((b"GIF87a", b"GIF89a"))
            else ".webp"
            if data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            else None
        )
        if suffix is None:
            assets.append({"reference": reference, "kind": "unavailable", "reason": "not recognized raster bytes"})
            continue
        sha = hashlib.sha256(data).hexdigest()
        relative = f"assets/{sha}{suffix}"
        target = output / relative
        target.parent.mkdir(exist_ok=True)
        if not target.exists():
            target.write_bytes(data)
        assets.append(
            {
                "reference": reference,
                "path": relative,
                "kind": "copied-at-export",
                "sha256": sha,
                "bytes": len(data),
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "qualification": "Current referenced file; equality to bytes at conversation time is unverified",
            }
        )
    document["source"]["assets"] = assets


def entry(provider: str, selected: dict[str, Any], version: str, method: str, payload: Any) -> dict[str, Any]:
    """Retain native payload with a small separately labelled capture envelope."""
    info = payload.get("thread", payload.get("info") or {})
    title = info.get("name") or info.get("custom_title") or info.get("summary") or info.get("preview")
    document = {
        "version": 1,
        "key": f"{provider}-{selected['sessionId']}",
        "provider": provider,
        "sessionId": selected["sessionId"],
        "title": title or f"{provider.title()} everyday conversation",
        "source": {
            "kind": "native-api",
            "corpus": "everyday",
            "method": method,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "host": "local everyday-history snapshot",
            "version": version,
            "readOnly": True,
            "workspace": selected["cwd"],
            "coverage": {
                "usage": "only fields returned by native history; absence is unknown",
                "runtime": "isolated reader; original runtime not observed",
                "missing": ["live delta timing", "complete billing records", "uncaptured asset bytes"],
            },
        },
        "payload": payload,
    }
    document["source"]["summary"] = audit(document)
    if provider == "claude":
        document["source"]["coverage"]["historySemantics"] = (
            "SDK selected main parent chain; compaction summaries replace earlier messages. "
            "Not an exhaustive scan of every stored branch or pre-compaction message."
        )
    return document


async def read_codex(selection: dict[str, Any], output: Path, binary: Path) -> tuple[list[Any], Any]:
    """Read selected copied rollouts with credential-free native app-server."""
    rows = [row for row in selection["sessions"] if row["provider"] == "codex"]
    if not rows:
        return [], {}
    documents = []
    source = Path(selection["codexHome"]).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="pdum-058-long-codex-") as temporary:
        root = Path(temporary)
        home, profile, work = (root / name for name in ("home", "codex", "work"))
        for directory in (home, profile, work):
            directory.mkdir()
        before = {}
        for row in rows:
            path = Path(row["file"]).resolve()
            relative = path.relative_to(source)
            if relative.parts[0] not in ("sessions", "archived_sessions") or path.suffix != ".jsonl":
                raise ValueError("Selection must name a native rollout")
            before[str(path)] = digest(path)
            target = profile / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            if digest(target) != before[str(path)]:
                raise RuntimeError("Selected source changed during snapshot; select a stable history")
        projection = source / "thread_history_1.sqlite"
        with sqlite3.connect(f"{projection.as_uri()}?mode=ro", uri=True) as src:
            with sqlite3.connect(profile / projection.name) as dst:
                src.backup(dst)
        environment = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(home),
            "CODEX_HOME": str(profile),
            "TMPDIR": temporary,
            "LANG": "en_US.UTF-8",
        }
        version_process = await asyncio.create_subprocess_exec(
            str(binary), "--version", env=environment, stdout=asyncio.subprocess.PIPE
        )
        version = (await version_process.communicate())[0].decode().strip()
        overrides = [
            "analytics.enabled=false",
            "feedback.enabled=false",
            'cli_auth_credentials_store="file"',
            "features.apps=false",
            "features.plugins=false",
            "skills.bundled.enabled=false",
            'model_provider="history_offline"',
            'model_providers.history_offline.name="History only"',
            'model_providers.history_offline.base_url="http://127.0.0.1:1"',
            "model_providers.history_offline.requires_openai_auth=false",
            'model_providers.history_offline.wire_api="responses"',
        ]
        with (output / "codex-stderr.log").open("wb") as stderr:
            process = await asyncio.create_subprocess_exec(
                str(binary),
                "app-server",
                "--listen",
                "stdio://",
                *[arg for override in overrides for arg in ("-c", override)],
                cwd=work,
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr,
            )
            reader = Reader(process, output / "codex-protocol.jsonl")
            elapsed = []
            try:
                await reader.ok(
                    "initialize",
                    {
                        "clientInfo": {"name": "spike_058_long_history", "version": "0.0.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                loaded_before = await reader.ok("thread/loaded/list")
                for row in rows:
                    start = time.monotonic()
                    response = await reader.call("thread/read", {"threadId": row["sessionId"], "includeTurns": True})
                    if "error" in response:
                        raise RuntimeError(f"Native history read failed: {response['error']}")
                    thread = response["result"]["thread"]
                    documents.append(entry("codex", row, version, "app-server thread/read", {"thread": thread}))
                    elapsed.append(round(time.monotonic() - start, 3))
                loaded_after = await reader.ok("thread/loaded/list")
                assert loaded_before["data"] == loaded_after["data"] == []
                assert not any(
                    message.get("method", "").startswith(("turn/", "item/")) for message in reader.notifications
                )
            finally:
                if process.stdin:
                    process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        after = {path: digest(Path(path)) for path in before}
        assert before == after, "Selected source changed; do not claim unchanged history"
        evidence = {
            "version": version,
            "binarySha256": digest(binary),
            "methods": dict(reader.methods),
            "loadedBefore": loaded_before,
            "loadedAfter": loaded_after,
            "elapsedSeconds": elapsed,
            "sourceHashes": before,
            "sourceHistoryUnchanged": True,
            "ownedProcessReaped": process.returncode is not None,
            "notifications": reader.notifications,
        }
    return documents, evidence


async def read_claude(selection: dict[str, Any]) -> tuple[list[Any], Any]:
    """Use the launcher's SDK helper on copied native project paths only."""
    rows = [row for row in selection["sessions"] if row["provider"] == "claude"]
    source = Path(selection["claudeConfig"]).expanduser().resolve() / "projects"
    documents, evidence = [], []
    for row in rows:
        path = Path(row["file"]).resolve()
        relative = path.relative_to(source)
        if len(relative.parts) != 2 or path.suffix != ".jsonl":
            raise ValueError("Select a native top-level Claude transcript")
        before = digest(path)
        with tempfile.TemporaryDirectory(prefix="pdum-058-long-claude-") as temporary:
            root = Path(temporary)
            target = root / "claude" / "projects" / relative
            target.parent.mkdir(parents=True)
            (root / "anthropic").mkdir()
            shutil.copyfile(path, target)
            assert digest(target) == before
            profile = Profile(root, Path(row["cwd"]))
            start = time.monotonic()
            async with History(profile, operation_timeout=120) as history:
                info = await history.info(row["sessionId"])
                messages = await history.read(row["sessionId"])
                if not info or not messages:
                    raise RuntimeError("Official SDK did not discover selected native history")
                documents.append(
                    entry(
                        "claude",
                        row,
                        importlib.metadata.version("claude-agent-sdk"),
                        "pdum.claude_launcher.History → official SDK get_session_info/get_session_messages",
                        {"info": info, "messages": messages},
                    )
                )
            assert digest(target) == before == digest(path)
            evidence.append(
                {
                    "source": str(path),
                    "sourceSha256": before,
                    "sourceHistoryUnchanged": True,
                    "snapshotHistoryUnchanged": True,
                    "helperClosed": history.closed,
                    "elapsedSeconds": round(time.monotonic() - start, 3),
                }
            )
    return documents, evidence


async def extend(selection_path: Path, output: Path, binary: Path) -> None:
    """Append new documents, atomically publishing their metadata catalogue."""
    selection = json.loads(selection_path.read_text())
    catalog_path = output / "catalog.json"
    catalog = json.loads(catalog_path.read_text())
    keys = {row["key"] for row in catalog["sessions"]}
    if any(f"{row['provider']}-{row['sessionId']}" in keys for row in selection["sessions"]):
        raise ValueError("Selected history already exported; never overwrite existing documents")
    evidence_dir = output / "long-corpus" / datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%S%f")
    evidence_dir.mkdir(parents=True)
    codex, codex_evidence = await read_codex(selection, evidence_dir, binary.resolve())
    claude, claude_evidence = await read_claude(selection)
    documents = [*codex, *claude]
    for document in documents:
        capture_referenced_assets(document, output)
        save(output / "documents" / f"{document['key']}.json", document)
    entries = [{key: value for key, value in document.items() if key != "payload"} for document in documents]
    catalog["sessions"] = [*entries, *catalog["sessions"]]
    temporary_catalog = output / "catalog.next.json"
    save(temporary_catalog, catalog)
    temporary_catalog.replace(catalog_path)
    save(
        evidence_dir / "evidence.json",
        {
            "codex": codex_evidence,
            "claude": claude_evidence,
            "inference": {"submittedTurns": 0, "providerTokens": 0, "estimatedNewInferenceUsd": 0},
            "summaries": [
                {"provider": document["provider"], **document["source"]["summary"]} for document in documents
            ],
        },
    )
    print(
        json.dumps(
            {
                "addedSessions": len(documents),
                "catalogSessions": len(catalog["sessions"]),
                "summaries": [{"provider": doc["provider"], **doc["source"]["summary"]} for doc in documents],
            }
        )
    )


@app.command()
def main(
    selection: Path = typer.Option(..., exists=True, dir_okay=False),
    output: Path = typer.Option(..., exists=True, file_okay=False),
    binary: Path = typer.Option(..., exists=True, dir_okay=False),
) -> None:
    """Read explicitly selected history; no login, resume, fork or model call."""
    os.umask(0o077)
    asyncio.run(extend(selection.resolve(), output.resolve(), binary))


if __name__ == "__main__":
    app()
