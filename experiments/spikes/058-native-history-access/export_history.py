"""Export native history from explicitly selected isolated research corpora.

Run with the production uv environment; the Claude adapter deliberately reuses
the launcher's public History class. This is disposable study code, not an
ingestion configuration or a new persisted agent-history schema.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import sqlite3
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import typer
from pdum.claude_launcher.profiles import Profile
from pdum.claude_launcher.storage import History

app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)
READ_METHODS = frozenset(
    {
        "initialize",
        "thread/list",
        "thread/loaded/list",
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "thread/items/read",
    }
)


def save(path: Path, value: Any) -> None:
    """Write a private local export without printing transcript contents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def fingerprint(directory: Path) -> dict[str, str]:
    """Hash selected history files, without opening credentials or settings."""
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*.jsonl"))
        if path.is_file() and not path.is_symlink()
    }


def assert_history_only(method: str) -> None:
    """Reject every protocol operation beyond the inspected history surface."""
    if method not in READ_METHODS:
        raise ValueError(f"Not a history inspection method: {method}")


class Reader:
    """Small sequential JSON-RPC stdio reader with a strict read allowlist."""

    def __init__(self, process: asyncio.subprocess.Process, trace: Path) -> None:
        self.process = process
        self.trace = trace
        self.sequence = 0
        self.notifications: list[dict[str, Any]] = []
        self.methods: Counter[str] = Counter()
        self.buffer = bytearray()

    def record(self, direction: str, message: Any) -> None:
        with self.trace.open("a") as stream:
            stream.write(json.dumps({"direction": direction, "message": message}) + "\n")

    async def line(self) -> Any:
        assert self.process.stdout is not None
        while b"\n" not in self.buffer:
            chunk = await self.process.stdout.read(65536)
            if not chunk:
                raise RuntimeError("Native reader exited before replying")
            self.buffer.extend(chunk)
        raw, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(raw)

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        assert_history_only(method)
        self.sequence += 1
        self.methods[method] += 1
        message = {"id": self.sequence, "method": method, "params": params or {}}
        self.record("client", message)
        assert self.process.stdin is not None
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()
        async with asyncio.timeout(30):
            while True:
                response = await self.line()
                self.record("server", response)
                if response.get("id") == self.sequence and "method" not in response:
                    return response
                self.notifications.append(response)
                if "id" in response and "method" in response:
                    raise RuntimeError("History reader unexpectedly received an interactive callback")

    async def ok(self, method: str, params: dict[str, Any] | None = None) -> Any:
        response = await self.call(method, params)
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response["result"]

    async def pages(self, method: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        pages: list[dict[str, Any]] = []
        seen: set[str] = set()
        while True:
            response = await self.call(method, params)
            pages.append(response)
            cursor = response.get("result", {}).get("nextCursor")
            if not cursor or "error" in response:
                return pages
            if cursor in seen:
                raise RuntimeError(f"Repeated cursor from {method}")
            seen.add(cursor)
            params = {**params, "cursor": cursor}


def snapshot_codex(source: Path, target: Path) -> dict[str, Any]:
    """Clone rollouts and the native projection; let Codex rebuild its catalogue.

    Copying only rollouts cannot materialize paginated history without a resume.
    SQLite's backup API copies the existing projection without interpreting it.
    No source config, auth, plugins, skills or executable hooks are copied.
    """
    target.mkdir(parents=True)
    count = 0
    for name in ("sessions", "archived_sessions"):
        directory = source / name
        if directory.is_dir():
            shutil.copytree(directory, target / name)
            count += len(list(directory.rglob("*.jsonl")))
    projection = source / "thread_history_1.sqlite"
    copied = False
    if projection.is_file():
        with sqlite3.connect(f"{projection.as_uri()}?mode=ro", uri=True) as src:
            with sqlite3.connect(target / projection.name) as dst:
                src.backup(dst)
        copied = True
    return {
        "rolloutFiles": count,
        "nativeProjectionCopied": copied,
        "catalogue": "rebuilt by native app-server from copied rollouts",
    }


async def export_codex(source: Path, output: Path, binary: Path, captured_at: str) -> tuple[list[Any], Any]:
    source = source.resolve()
    before = {name: fingerprint(source / name) for name in ("sessions", "archived_sessions")}
    documents = []
    with tempfile.TemporaryDirectory(prefix="pdum-058-codex-") as temporary:
        isolated = Path(temporary)
        home, work, profile = isolated / "home", isolated / "work", isolated / "codex"
        home.mkdir()
        work.mkdir()
        snapshot = snapshot_codex(source, profile)
        # A local closed provider endpoint makes accidental inference impossible.
        # No auth/home configuration is inherited; no normal home is inspected.
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
        with (output / "codex-stderr.log").open("wb") as stderr:
            process = await asyncio.create_subprocess_exec(
                str(binary),
                "app-server",
                "--listen",
                "stdio://",
                *[arg for value in overrides for arg in ("-c", value)],
                cwd=work,
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr,
            )
            reader = Reader(process, output / "codex-protocol.jsonl")
            try:
                initialize = await reader.ok(
                    "initialize",
                    {
                        "clientInfo": {"name": "spike_058_history", "version": "0.0.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                loaded_before = await reader.ok("thread/loaded/list")
                list_params = {
                    "modelProviders": [],
                    "sourceKinds": ["cli", "vscode", "exec", "appServer", "subAgent", "unknown"],
                    "limit": 100,
                }
                # Backfill is async. Await discovery of the selected small corpus;
                # an incomplete catalogue is reported rather than repaired by resume.
                deadline = time.monotonic() + 12
                while True:
                    listing = await reader.pages("thread/list", list_params)
                    archived = await reader.pages("thread/list", {**list_params, "archived": True})
                    rows = {
                        row["id"]: row
                        for page in [*listing, *archived]
                        for row in page.get("result", {}).get("data", [])
                    }
                    if len(rows) >= snapshot["rolloutFiles"] or time.monotonic() >= deadline:
                        break
                    await asyncio.sleep(0.2)
                list_before = list(rows)
                for session_id, row in rows.items():
                    full = await reader.call("thread/read", {"threadId": session_id, "includeTurns": True})
                    turns = await reader.pages(
                        "thread/turns/list",
                        {"threadId": session_id, "itemsView": "full", "sortDirection": "asc", "limit": 2},
                    )
                    items = await reader.pages(
                        "thread/items/list", {"threadId": session_id, "sortDirection": "asc", "limit": 2}
                    )
                    reads = []
                    for turn in [t for page in turns for t in page.get("result", {}).get("data", [])]:
                        ids = [item["id"] for item in turn.get("items", [])]
                        for offset in range(0, len(ids), 100):
                            reads.append(
                                {
                                    "turnId": turn["id"],
                                    "itemIds": ids[offset : offset + 100],
                                    "response": await reader.call(
                                        "thread/items/read",
                                        {
                                            "threadId": session_id,
                                            "turnId": turn["id"],
                                            "itemIds": ids[offset : offset + 100],
                                        },
                                    ),
                                }
                            )
                    thread = full.get("result", {}).get("thread", row)
                    types = Counter(
                        item.get("type", "unknown")
                        for turn in thread.get("turns", [])
                        for item in turn.get("items", [])
                    )
                    errors = [
                        reply["error"]
                        for reply in [full, *turns, *items, *[entry["response"] for entry in reads]]
                        if "error" in reply
                    ]
                    document = {
                        "version": 1,
                        "key": f"codex-{session_id}",
                        "provider": "codex",
                        "sessionId": session_id,
                        "title": thread.get("name") or thread.get("preview") or session_id,
                        "source": {
                            "kind": "native-api",
                            "method": (
                                "app-server thread/read + thread/turns/list + thread/items/list + thread/items/read"
                            ),
                            "capturedAt": captured_at,
                            "host": "local research snapshot",
                            "profile": str(source),
                            "version": version,
                            "readOnly": True,
                            "snapshot": snapshot,
                            "coverage": {
                                "turns": len(thread.get("turns", [])),
                                "itemTypes": dict(types),
                                "historyMode": thread.get("historyMode"),
                                "errors": errors,
                                "usage": "not returned by structured history; unknown, not zero",
                                "runtime": "notLoaded in this isolated reader; source runtime unknown",
                                "missing": [
                                    "live delta timing",
                                    "complete provider usage",
                                    "native output before persistence truncation",
                                ],
                            },
                        },
                        "payload": {
                            "thread": thread,
                            "readResponse": full,
                            "turnPages": turns,
                            "itemPages": items,
                            "itemReads": reads,
                        },
                    }
                    documents.append(document)
                list_after = [
                    row["id"]
                    for page in await reader.pages("thread/list", list_params)
                    for row in page.get("result", {}).get("data", [])
                ]
                list_after += [
                    row["id"]
                    for page in await reader.pages("thread/list", {**list_params, "archived": True})
                    for row in page.get("result", {}).get("data", [])
                ]
                loaded_after = await reader.ok("thread/loaded/list")
                assert loaded_before["data"] == loaded_after["data"] == []
                assert set(list_before) == set(list_after)
                assert not any(
                    message.get("method", "").startswith(("turn/", "item/"))
                    or message.get("method") == "thread/tokenUsage/updated"
                    for message in reader.notifications
                )
                evidence = {
                    "version": version,
                    "binary": str(binary),
                    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "initialize": initialize,
                    "snapshot": snapshot,
                    "loadedBefore": loaded_before,
                    "loadedAfter": loaded_after,
                    "listedBefore": list_before,
                    "listedAfter": list_after,
                    "methods": dict(reader.methods),
                    "notifications": reader.notifications,
                    "providerEndpoint": "unreachable local endpoint; no credentials copied",
                }
            finally:
                if process.stdin:
                    process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        evidence["ownedProcessReaped"] = process.returncode is not None
    after = {name: fingerprint(source / name) for name in ("sessions", "archived_sessions")}
    assert before == after, "Original Codex history changed during inspection"
    evidence["sourceHistoryUnchanged"] = True
    evidence["sourceHistoryHashes"] = before
    return documents, evidence


async def export_claude(
    source: Path, workspace: Path, output: Path, captured_at: str, native_config: Path | None = None
) -> tuple[list[Any], Any]:
    source, workspace = source.resolve(), workspace.resolve()
    config = native_config.resolve() if native_config else source / "claude"
    projects = config / "projects"
    before = fingerprint(projects)
    documents = []
    with tempfile.TemporaryDirectory(prefix="pdum-058-claude-") as temporary:
        isolated = Path(temporary)
        (isolated / "claude").mkdir()
        (isolated / "anthropic").mkdir()
        shutil.copytree(projects, isolated / "claude" / "projects")
        profile = Profile(isolated, workspace)
        async with History(profile) as history:
            listed_before = await history.list()
            for row in listed_before:
                session_id = row["session_id"]
                info = await history.info(session_id)
                messages = await history.read(session_id)
                blocks = Counter(
                    block.get("type", "unknown")
                    for message in messages
                    for block in message.get("message", {}).get("content", [])
                    if isinstance(block, dict)
                )
                documents.append(
                    {
                        "version": 1,
                        "key": f"claude-{session_id}",
                        "provider": "claude",
                        "sessionId": session_id,
                        "title": (info or row).get("custom_title") or (info or row).get("summary") or session_id,
                        "source": {
                            "kind": "native-api",
                            "method": (
                                "pdum.claude_launcher.History → official SDK "
                                "list_sessions/get_session_info/get_session_messages"
                            ),
                            "capturedAt": captured_at,
                            "host": "local research snapshot",
                            "profile": str(source),
                            "nativeConfigDirectory": str(config),
                            "workspace": str(workspace),
                            "version": importlib.metadata.version("claude-agent-sdk"),
                            "readOnly": True,
                            "coverage": {
                                "messages": len(messages),
                                "blockTypes": dict(blocks),
                                "usage": "only native message usage fields, when present; no billing claim",
                                "runtime": "history helper only; no conversation worker started",
                                "missing": ["live stream timing", "worker result/cost records not returned by helper"],
                            },
                        },
                        "payload": {"info": info, "messages": messages},
                    }
                )
            listed_after = await history.list()
            assert listed_before == listed_after, "Native Claude list changed during read"
            helper_pid = history.pid
        snapshot_after = fingerprint(isolated / "claude" / "projects")
        assert before == snapshot_after, "Claude SDK changed copied history"
        evidence = {
            "sdkVersion": importlib.metadata.version("claude-agent-sdk"),
            "launcherVersion": importlib.metadata.version("habemus-papadum-claude-launcher"),
            "listedBefore": [row["session_id"] for row in listed_before],
            "listedAfter": [row["session_id"] for row in listed_after],
            "helperPid": helper_pid,
            "helperClosed": history.closed,
            "nativeHistoryUnchanged": True,
            "sourceHistoryHashes": before,
            "operations": ["History.list", "History.info", "History.read", "History.list", "History.close"],
            "credentialLookup": "authenticate=False in existing History._start",
            "copyScope": "claude/projects only; no auth/settings/config copied",
        }
    assert before == fingerprint(projects), "Original Claude history changed during inspection"
    evidence["sourceHistoryUnchanged"] = True
    return documents, evidence


async def export_all(
    codex_source: Path,
    claude_profile: Path,
    claude_workspace: Path,
    output: Path,
    binary: Path,
    extra_claude_config: Path | None = None,
    extra_claude_workspace: Path | None = None,
) -> None:
    output = output.resolve()
    if output.exists():
        raise ValueError("Choose a new output directory; exports are never overwritten")
    output.mkdir(parents=True)
    captured_at = datetime.now(timezone.utc).isoformat()
    codex, codex_evidence = await export_codex(codex_source, output, binary.resolve(), captured_at)
    claude, claude_evidence = await export_claude(claude_profile, claude_workspace, output, captured_at)
    if extra_claude_config and extra_claude_workspace:
        extra, extra_evidence = await export_claude(
            extra_claude_config.parent, extra_claude_workspace, output, captured_at, extra_claude_config
        )
        claude.extend(extra)
        claude_evidence["additionalCorpus"] = extra_evidence
    documents = [*codex, *claude]
    if not codex or not claude:
        raise RuntimeError("Both providers must supply a real native session")
    for document in documents:
        save(output / "documents" / f"{document['key']}.json", document)
    save(
        output / "catalog.json",
        {
            "version": 1,
            "sessions": [{key: value for key, value in document.items() if key != "payload"} for document in documents],
        },
    )
    save(
        output / "evidence.json",
        {
            "capturedAt": captured_at,
            "platform": platform.platform(),
            "python": platform.python_version(),
            "codex": codex_evidence,
            "claude": claude_evidence,
            "inference": {
                "submittedTurns": 0,
                "providerTokens": 0,
                "estimatedNewInferenceUsd": 0,
                "note": "Reading old paid sessions does not reprice their history; assistant effort excluded.",
            },
        },
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "sessions": len(documents),
                "codex": len(codex),
                "claude": len(claude),
                "newInferenceUsd": 0,
                "sourceHistoryUnchanged": True,
            }
        )
    )


@app.command()
def main(
    codex_source: Path = typer.Option(..., exists=True, file_okay=False),
    claude_profile: Path = typer.Option(..., exists=True, file_okay=False),
    claude_workspace: Path = typer.Option(..., exists=True, file_okay=False),
    output: Path = typer.Option(...),
    binary: Path = typer.Option(..., exists=True, dir_okay=False),
    extra_claude_config: Path | None = typer.Option(None, exists=True, file_okay=False),
    extra_claude_workspace: Path | None = typer.Option(None, exists=True, file_okay=False),
) -> None:
    """Read selected research profiles using native APIs, never resume or run."""
    os.umask(0o077)
    if bool(extra_claude_config) != bool(extra_claude_workspace):
        raise typer.BadParameter("Extra Claude config and workspace must be supplied together")
    asyncio.run(
        export_all(
            codex_source, claude_profile, claude_workspace, output, binary, extra_claude_config, extra_claude_workspace
        )
    )


if __name__ == "__main__":
    app()
