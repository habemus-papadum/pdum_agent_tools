"""Disposable owned-session service over the existing Codex and Claude launchers.

No provider process starts on import or configuration inspection. The browser
owns live protocol/query operations; this service owns profiles, processes and
read-only native history snapshots.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import socket
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psutil
import uvicorn
from fastapi import HTTPException, Request
from pdum.claude_launcher.authentication import AuthSpec
from pdum.claude_launcher.management import create_app
from pdum.claude_launcher.profiles import Profile, create_profile, load_profile
from pdum.claude_launcher.runtime import ClaudeManager, LaunchOptions
from pdum.claude_launcher.storage import History
from pdum.codex_launcher.layout import default_codex_home
from pdum.codex_launcher.profiles import ProfileSpec
from pdum.codex_launcher.profiles import create_profile as create_codex_profile
from pdum.codex_launcher.runtime import LaunchOptions as CodexLaunchOptions
from pdum.codex_launcher.runtime import launch as launch_codex
from websockets.asyncio.client import connect

REPO = Path(__file__).resolve().parents[3]
DEFAULT_LAB = REPO / "experiments/artifacts/067-live-session-workspace"
DEFAULT_TOKEN = REPO / "experiments/artifacts/066-claude-setup-token/setup-token.txt"


def now() -> str:
    return datetime.now(UTC).isoformat()


def timestamp(value: Any, *, milliseconds: bool = False) -> str | None:
    """Normalize a known native clock unit for the temporary catalogue view."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        return datetime.fromtimestamp(value / 1000 if milliseconds else value, UTC).isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def save(path: Path, value: Any) -> None:
    """Write local evidence without printing its payload."""
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(path.suffix + ".tmp")
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    staging.chmod(0o600)
    staging.replace(path)


def public_socket(url: str, hostname: str) -> str:
    """Return a direct browser endpoint on the preview host's address."""
    parsed = urlsplit(url)
    host = f"[{hostname}]" if ":" in hostname else hostname
    return urlunsplit((parsed.scheme, f"{host}:{parsed.port}", parsed.path, parsed.query, ""))


class NativeReader:
    """Sequential native RPC reads; never resumes or starts a thread."""

    def __init__(self, socket):
        self.socket = socket
        self.sequence = 0
        self.notifications: list[dict] = []

    async def call(self, method: str, params: dict | None = None) -> dict:
        if method not in {
            "initialize",
            "thread/list",
            "thread/loaded/list",
            "thread/read",
            "thread/turns/list",
            "thread/items/list",
        }:
            raise ValueError("This reader performs native history inspection only")
        self.sequence += 1
        identity = f"history-{self.sequence}"
        await self.socket.send(json.dumps({"id": identity, "method": method, "params": params or {}}))
        async with asyncio.timeout(30):
            while True:
                value = json.loads(await self.socket.recv())
                if value.get("id") == identity and "method" not in value:
                    return value
                self.notifications.append(value)
                if "id" in value and "method" in value:
                    raise RuntimeError("Native history inspection unexpectedly requested an interactive callback")

    async def pages(self, method: str, params: dict) -> list[dict]:
        values: list[dict] = []
        seen: set[str] = set()
        while True:
            page = await self.call(method, params)
            values.append(page)
            cursor = page.get("result", {}).get("nextCursor")
            if not cursor or "error" in page:
                return values
            if cursor in seen:
                raise RuntimeError("Native history pagination repeated its cursor")
            seen.add(cursor)
            params = {**params, "cursor": cursor}


@dataclass
class OwnedRun:
    id: str
    provider: str
    cwd: str
    model: str
    profile_directory: Path
    websocket_url: str
    thread_id: str | None = None
    worker_id: str | None = None
    state: str = "ready"
    created_at: str = field(default_factory=now)
    ended_at: str | None = None
    owner_id: str | None = None
    continuation: dict | None = None
    runtime: dict = field(default_factory=dict)
    server: Any = field(default=None, repr=False)
    context: Any = field(default=None, repr=False)
    claude_profile: Profile | None = field(default=None, repr=False)
    snapshot: dict | None = field(default=None, repr=False)
    history_error: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def public(self, hostname: str = "127.0.0.1") -> dict:
        value = {
            "id": self.id,
            "provider": self.provider,
            "cwd": self.cwd,
            "model": self.model,
            "profileDirectory": str(self.profile_directory),
            "websocketUrl": public_socket(self.websocket_url, hostname),
            "threadId": self.thread_id,
            "workerId": self.worker_id,
            "state": self.state,
            "createdAt": self.created_at,
            "endedAt": self.ended_at,
            "owned": True,
            "ownerId": self.owner_id,
            "ownerPid": os.getpid(),
            "runtime": self.runtime,
        }
        if self.continuation:
            value["continuation"] = self.continuation
        if self.history_error:
            value["historyError"] = self.history_error
        return value


class LiveLab:
    """One application-owned collection of experiment runs; no recovery daemon."""

    def __init__(self, directory: Path | None = None):
        self.directory = (directory or Path(os.environ.get("PDUM_LIVE_LAB_DIR", DEFAULT_LAB))).expanduser().resolve()
        self.workspace = self.directory / "workspace"
        self.codex_profile = self.directory / "profiles/codex"
        self.claude_profile = self.directory / "profiles/claude"
        self.auth_source = Path(
            os.environ.get("PDUM_CODEX_AUTH_SOURCE", default_codex_home() / "auth.json")
        ).expanduser()
        self.token_file = Path(os.environ.get("PDUM_CLAUDE_TOKEN_FILE", DEFAULT_TOKEN)).expanduser()
        self.manager = ClaudeManager({})
        self.owner_id = uuid4().hex
        self.runs: dict[str, OwnedRun] = {}
        self.profile_lock = asyncio.Lock()
        self.lifecycle_lock = asyncio.Lock()
        self.closing = False
        self.port = 0
        self.app = create_app(self.manager)
        self._routes()

    def prepare_workspace(self) -> None:
        self.workspace.mkdir(parents=True, exist_ok=True)
        sample = self.workspace / "sample.txt"
        if not sample.exists():
            sample.write_text("Live session study\nProvider-neutral marker: ORCHARD_067\nThere are three apples.\n")

    def configuration(self) -> dict:
        return {
            "defaultCwd": str(self.workspace),
            "providers": [
                {
                    "provider": "codex",
                    "model": "gpt-6-luna",
                    "profileDirectory": str(self.codex_profile),
                    "authAvailable": (self.codex_profile / "auth.json").is_file() or self.auth_source.is_file(),
                    "authDescription": "Auth snapshot only; no source settings, skills or sessions are copied",
                },
                {
                    "provider": "claude",
                    "model": "haiku",
                    "profileDirectory": str(self.claude_profile),
                    "authAvailable": self.token_file.is_file(),
                    "authDescription": "Operator setup-token reference resolved for each allocated worker",
                },
            ],
            "runs": [run.public() for run in self.runs.values()] + self.previous_records(),
            "ownerId": self.owner_id,
            "ownerPid": os.getpid(),
            "scope": "Only sessions started by this live study; no external session discovery or attachment",
        }

    def previous_records(self) -> list[dict]:
        """Inspect this lab's metadata; never adopt previous processes or handles."""
        records = []
        for path in sorted((self.directory / "runs").glob("*/run.json")):
            if path.parent.name in self.runs:
                continue
            try:
                value = json.loads(path.read_text())
                if not isinstance(value, dict) or value.get("id") != path.parent.name:
                    raise ValueError("run identity mismatch")
                recorded_state = value.get("state")
                value.update(
                    owned=False,
                    lastRecordedState=recorded_state,
                    state="ended" if recorded_state == "ended" else "unknown",
                    runtime={
                        "state": "ended" if recorded_state == "ended" else "unknown",
                        "observedAt": value.get("endedAt") or value.get("createdAt"),
                        "basis": "Previous owner record; process liveness was not re-established",
                    },
                )
                records.append(value)
            except (OSError, ValueError, TypeError):
                records.append(
                    {
                        "id": path.parent.name,
                        "owned": False,
                        "state": "unknown",
                        "runtime": {"state": "unknown", "basis": "Unreadable previous owner record"},
                    }
                )
        return records

    def known_workspaces(self, provider: str) -> list[Path]:
        paths = {self.workspace.resolve()}
        for value in [*(run.public() for run in self.runs.values()), *self.previous_records()]:
            if value.get("provider") == provider and isinstance(value.get("cwd"), str):
                paths.add(Path(value["cwd"]).expanduser().resolve())
        return sorted(path for path in paths if path.is_dir())

    async def observe(self, run: OwnedRun, hostname: str = "127.0.0.1") -> dict:
        """Return actual owned-process observation separately from run intent."""
        if run.provider == "codex":
            status = await run.server.status()
            identity = status.get("server") or {}
            alive = False
            try:
                process = psutil.Process(identity.get("pid", run.server.pid))
                alive = process.status() != psutil.STATUS_ZOMBIE and process.create_time() == identity.get(
                    "create_time"
                )
            except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
                pass
            run.runtime = {
                "state": "running" if alive else "stopped",
                "pid": run.server.pid,
                "processAlive": alive,
                "observedAt": now(),
                "basis": "Owned Codex PID identity",
            }
        else:
            worker = self.manager.worker(run.worker_id)
            run.runtime = {
                "state": worker.state,
                "pid": worker.pid,
                "exitCode": worker.exit_code,
                "reason": worker.reason,
                "observedAt": now(),
                "basis": "Current Claude manager worker",
            }
        return run.public(hostname)

    async def observations(self, hostname: str = "127.0.0.1") -> list[dict]:
        return [await self.observe(run, hostname) for run in self.runs.values()] + self.previous_records()

    @asynccontextmanager
    async def codex_reader(self, endpoint: str | None = None):
        """Use only native read methods, with a temporary owned server when needed."""
        if not self.codex_profile.is_dir():
            raise ValueError("No Codex lab profile exists yet")
        context = None
        if endpoint is None:
            context = launch_codex(self.codex_profile, CodexLaunchOptions(model="gpt-6-luna", host="0.0.0.0", port=0))
            server = await context.__aenter__()
            endpoint = server.endpoint
        try:
            async with connect(endpoint, max_size=None, proxy=None) as websocket:
                reader = NativeReader(websocket)
                initialized = await reader.call(
                    "initialize",
                    {
                        "clientInfo": {"name": "pdum-history-continuation", "version": "0.0.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                if "error" in initialized:
                    raise RuntimeError("Native history reader initialization was rejected")
                await websocket.send(json.dumps({"method": "initialized"}))
                yield reader, initialized.get("result")
        finally:
            if context is not None:
                await context.__aexit__(None, None, None)

    async def catalogue(self, provider: str) -> dict:
        """List native histories in this study's profile/workspace scope."""
        if provider not in {"codex", "claude"}:
            raise ValueError("Choose codex or claude")
        sessions = []
        errors = []
        if provider == "codex" and self.codex_profile.is_dir():
            async with self.codex_reader() as (reader, _version):
                pages = await reader.pages("thread/list", {"limit": 100, "sourceKinds": [], "sortKey": "updated_at"})
            for page in pages:
                if "error" in page:
                    errors.append(page["error"])
                for thread in page.get("result", {}).get("data", []):
                    sessions.append(
                        {
                            "provider": provider,
                            "sessionId": thread["id"],
                            "cwd": thread.get("cwd") or "",
                            "title": thread.get("name") or thread.get("preview") or thread["id"],
                            "profileDirectory": str(self.codex_profile),
                            "updatedAt": timestamp(thread.get("updatedAt")),
                            "native": thread,
                        }
                    )
        elif provider == "claude" and self.claude_profile.is_dir():
            base = load_profile(self.claude_profile)
            seen = set()
            for cwd in self.known_workspaces(provider):
                async with History(replace(base, workspace=cwd)) as history:
                    entries = await history.list()
                for info in entries:
                    key = (info["session_id"], str(cwd))
                    if key in seen:
                        continue
                    seen.add(key)
                    sessions.append(
                        {
                            "provider": provider,
                            "sessionId": info["session_id"],
                            "cwd": info.get("cwd") or str(cwd),
                            "title": info.get("custom_title") or info.get("summary") or info["session_id"],
                            "profileDirectory": str(self.claude_profile),
                            "updatedAt": timestamp(info.get("last_modified"), milliseconds=True),
                            "native": info,
                        }
                    )
        return {
            "sessions": sessions,
            "scope": "Native histories in this lab profile; Claude uses its base and recorded working directories",
            "errors": errors,
        }

    async def ensure_profile(self, provider: str) -> Profile | None:
        async with self.profile_lock:
            if provider == "codex":
                if not self.codex_profile.exists():
                    await create_codex_profile(
                        self.codex_profile,
                        ProfileSpec(
                            model="gpt-6-luna",
                            copy_auth=True,
                            auth_source=self.auth_source,
                            copy_skills=False,
                        ),
                    )
                return None
            if not self.claude_profile.exists():
                create_profile(
                    self.claude_profile,
                    workspace=self.workspace,
                    model="haiku",
                    setting_sources=("user",),
                    auth=AuthSpec("native"),
                )
            return load_profile(self.claude_profile)

    async def start(self, body: dict) -> OwnedRun:
        # Shutdown must include a launch which has entered native startup but has
        # not published its run record yet. This lock covers ownership only.
        async with self.lifecycle_lock:
            return await self._start(body)

    async def _start(self, body: dict) -> OwnedRun:
        if self.closing:
            raise RuntimeError("Live study is shutting down")
        provider = body.get("provider")
        if provider not in {"codex", "claude"}:
            raise ValueError("Choose codex or claude")
        cwd = Path(body.get("cwd") or self.workspace).expanduser().resolve()
        if not cwd.is_dir():
            raise ValueError("Choose an existing working directory")
        qualification = body.get("qualification", False)
        if not isinstance(qualification, bool):
            raise ValueError("qualification must be boolean")
        base = await self.ensure_profile(provider)
        continuation = body.get("continuation")
        if continuation is not None:
            if not isinstance(continuation, dict) or continuation.get("kind") not in {"resume", "fork"}:
                raise ValueError("Choose an explicit resume or fork continuation")
            session_id = continuation.get("sourceSessionId")
            if not isinstance(session_id, str) or not session_id:
                raise ValueError("A source native conversation ID is required")
            point = continuation.get("pointId")
            kind = continuation.get("pointKind")
            if continuation["kind"] == "resume" and (point is not None or kind is not None):
                raise ValueError("Resume uses the latest saved context; choose fork for a historical point")
            if point is not None and (
                not isinstance(point, str) or kind != ("turn" if provider == "codex" else "message")
            ):
                raise ValueError("The branch point kind must match the selected provider")
            if point is None and kind is not None:
                raise ValueError("A branch point ID is required with its kind")
            choice = await self.history_choice(provider, session_id, str(cwd))
            if point is not None and not any(p["id"] == point and p["kind"] == kind for p in choice["branchPoints"]):
                raise ValueError("Choose a supported saved branch point from this conversation")
            continuation = {
                key: continuation[key]
                for key in ("kind", "sourceSessionId", "pointId", "pointKind")
                if key in continuation
            }
        identity = uuid4().hex
        if provider == "codex":
            if not (self.codex_profile / "auth.json").is_file():
                raise ValueError("No file-backed Codex authentication was available for this lab profile")
            context = launch_codex(
                self.codex_profile,
                CodexLaunchOptions(
                    model="gpt-6-luna",
                    host="0.0.0.0",
                    port=0,
                    config_overrides={"sandbox_mode": '"danger-full-access"', "approval_policy": '"never"'},
                ),
            )
            server = await context.__aenter__()
            run = OwnedRun(
                identity,
                provider,
                str(cwd),
                "gpt-6-luna",
                self.codex_profile,
                server.endpoint,
                server=server,
                context=context,
            )
        else:
            token = self.token_file.read_text().strip()
            if not token or any(char.isspace() for char in token) or "\x00" in token:
                raise ValueError("The supplied Claude token reference is missing or malformed")
            selected = replace(base, workspace=cwd)
            self.manager.profiles[identity] = selected
            options = LaunchOptions(
                model="haiku",
                environment={"CLAUDE_CODE_OAUTH_TOKEN": token},
                max_turns=2 if qualification else None,
                max_budget_usd=0.05 if qualification else None,
            )
            resume = continuation["sourceSessionId"] if continuation else None
            if continuation and continuation["kind"] == "fork":
                async with History(selected) as history:
                    forked = await history.fork(resume, up_to_message_id=continuation.get("pointId"))
                resume = forked["session_id"]
            worker = await self.manager.allocate(identity, resume=resume, options=options)
            run = OwnedRun(
                identity,
                provider,
                str(cwd),
                "haiku",
                self.claude_profile,
                f"ws://127.0.0.1:{self.port}/workers/{worker.id}",
                thread_id=worker.conversation_id,
                worker_id=worker.id,
                claude_profile=selected,
            )
        run.continuation = continuation
        run.owner_id = self.owner_id
        self.runs[identity] = run
        await asyncio.to_thread(save, self.directory / "runs" / identity / "run.json", await self.observe(run))
        return run

    def find(self, identity: str) -> OwnedRun:
        try:
            return self.runs[identity]
        except KeyError:
            if any(row.get("id") == identity for row in self.previous_records()):
                raise HTTPException(409, "This is a previous owner record; no process handle was adopted") from None
            raise HTTPException(404, "Unknown run in this live study") from None

    async def native_document(
        self, provider: str, session_id: str, cwd: str | None = None, *, endpoint: str | None = None
    ) -> dict:
        """Read native saved content without using debug captures as history."""
        if provider not in {"codex", "claude"}:
            raise ValueError("Choose codex or claude")
        source = {
            "kind": "native-api",
            "capturedAt": now(),
            "readOnly": True,
            "host": socket.gethostname(),
            "cachedAfterEnd": False,
        }
        if provider == "codex":
            async with self.codex_reader(endpoint) as (reader, version):
                full = await reader.call("thread/read", {"threadId": session_id, "includeTurns": True})
                if "error" in full:
                    raise ValueError(f"Native history is not available: {full['error'].get('message', 'read failed')}")
                thread = full["result"]["thread"]
                native_cwd = thread.get("cwd") or ""
                if cwd and Path(cwd).expanduser().resolve() != Path(native_cwd).expanduser().resolve():
                    raise ValueError("Continuation stays in the saved conversation's recorded working directory")
                turns = await reader.pages(
                    "thread/turns/list",
                    {
                        "threadId": session_id,
                        "itemsView": "full",
                        "sortDirection": "asc",
                        "limit": 100,
                    },
                )
                items = await reader.pages(
                    "thread/items/list",
                    {
                        "threadId": session_id,
                        "sortDirection": "asc",
                        "limit": 100,
                    },
                )
                payload = {
                    "thread": thread,
                    "readResponse": full,
                    "turnPages": turns,
                    "itemPages": items,
                    "itemReads": [],
                }
                source.update(
                    profile=str(self.codex_profile),
                    cwd=native_cwd,
                    method="app-server thread/read + thread/turns/list + thread/items/list",
                    version=version,
                    coverage={
                        "errors": [page["error"] for page in [*turns, *items] if "error" in page],
                        "notes": (
                            "Persisted native items. Runtime status is relative to the reader's server, "
                            "not a global liveness claim"
                        ),
                    },
                )
                title = thread.get("name") or thread.get("preview") or session_id
        else:
            selected_cwd = Path(cwd or self.workspace).expanduser().resolve()
            if selected_cwd not in self.known_workspaces(provider):
                raise ValueError("Choose a recorded working directory from this lab's native history catalogue")
            base = load_profile(self.claude_profile)
            async with History(replace(base, workspace=selected_cwd)) as history:
                info = await history.info(session_id)
                messages = await history.read(session_id)
            if info is None and not messages:
                raise ValueError("No saved Claude messages are available for this conversation")
            native_cwd = (info or {}).get("cwd") or str(selected_cwd)
            if Path(native_cwd).expanduser().resolve() != selected_cwd:
                raise ValueError("Continuation stays in the saved conversation's recorded working directory")
            payload = {"info": info, "messages": messages}
            source.update(
                profile=str(self.claude_profile),
                cwd=native_cwd,
                method="official Python SDK History.info/read",
                version=importlib.metadata.version("claude-agent-sdk"),
                coverage={
                    "notes": "Public helper selected messages; live control/results and wrapper clocks may differ"
                },
            )
            title = (info or {}).get("custom_title") or (info or {}).get("summary") or session_id
        return {
            "version": 1,
            "key": f"{provider}-{session_id}",
            "provider": provider,
            "sessionId": session_id,
            "title": title,
            "source": source,
            "payload": payload,
        }

    async def history_choice(self, provider: str, session_id: str, cwd: str | None = None) -> dict:
        document = await self.native_document(provider, session_id, cwd)
        source = document["source"]
        points = []
        if provider == "codex":
            thread = document["payload"]["thread"]
            turns = {turn["id"]: turn for turn in thread.get("turns", [])}
            for page in document["payload"]["turnPages"]:
                for entry in page.get("result", {}).get("data", []):
                    turn = entry.get("turn", entry)
                    if turn.get("id"):
                        turns.setdefault(turn["id"], turn)
            for index, turn in enumerate(turns.values(), 1):
                if turn.get("status") not in {"completed", "interrupted", "failed"}:
                    continue
                points.append(
                    {
                        "id": turn["id"],
                        "kind": "turn",
                        "label": f"Through turn {index} · {turn.get('status')} · {turn['id'][:8]}",
                    }
                )
            native = thread
            updated = timestamp(thread.get("updatedAt"))
        else:
            messages = document["payload"]["messages"]
            for index, record in enumerate(messages, 1):
                message = record.get("message") or {}
                content = message.get("content") or []
                # Expose assistant response boundaries, not an unresolved tool-use
                # record which would need a separate incomplete-context study.
                if record.get("type") != "assistant" or any(
                    isinstance(block, dict) and block.get("type") == "tool_use"
                    for block in content
                    if isinstance(content, list)
                ):
                    continue
                if record.get("uuid"):
                    points.append(
                        {
                            "id": record["uuid"],
                            "kind": "message",
                            "label": f"Through assistant message {index} · {record['uuid'][:8]}",
                        }
                    )
            native = document["payload"]["info"]
            updated = timestamp((native or {}).get("last_modified"), milliseconds=True)
        reference = {
            "provider": provider,
            "sessionId": session_id,
            "cwd": source["cwd"],
            "title": document["title"],
            "profileDirectory": source["profile"],
            "updatedAt": updated,
            "native": native,
        }
        return {"reference": reference, "document": document, "branchPoints": points}

    async def snapshot(self, run: OwnedRun) -> dict:
        if run.state == "ended":
            if run.snapshot is None:
                raise ValueError(run.history_error or "No saved snapshot was available when the runtime ended")
            return {**run.snapshot, "source": {**run.snapshot["source"], "cachedAfterEnd": True}}
        if not run.thread_id:
            raise ValueError("The client has not registered the native thread identity yet")
        document = await self.native_document(
            run.provider,
            run.thread_id,
            run.cwd,
            endpoint=run.websocket_url if run.provider == "codex" else None,
        )
        run.snapshot = document
        run.history_error = None
        await asyncio.to_thread(save, self.directory / "runs" / run.id / "history.json", document)
        return document

    async def end(self, run: OwnedRun) -> dict:
        async with run.lock:
            if run.state == "ended":
                return run.public()
            try:
                await self.snapshot(run)
            except Exception as error:
                run.history_error = str(error)
            finally:
                if run.provider == "codex":
                    await run.context.__aexit__(None, None, None)
                else:
                    await self.manager.stop(run.worker_id)
            run.state = "ended"
            run.ended_at = now()
            value = await self.observe(run)
            await asyncio.to_thread(save, self.directory / "runs" / run.id / "run.json", value)
            return value

    async def end_all(self) -> dict:
        """End the explicitly enumerated current-owner targets, not prior-owner records."""
        async with self.lifecycle_lock:
            targets = [run for run in self.runs.values() if run.state != "ended"]
            outcomes = await asyncio.gather(*(self.end(run) for run in targets), return_exceptions=True)
        return {
            "targetIds": [run.id for run in targets],
            "results": [value for value in outcomes if not isinstance(value, BaseException)],
            "failures": [
                {"id": run.id, "error": str(value)}
                for run, value in zip(targets, outcomes, strict=True)
                if isinstance(value, BaseException)
            ],
            "effect": "Ended the enumerated runtimes owned by this service; other owners were not touched",
        }

    async def close(self) -> None:
        async with self.lifecycle_lock:
            self.closing = True
            results = await asyncio.gather(*(self.end(run) for run in self.runs.values()), return_exceptions=True)
            await self.manager.aclose()
            failures = sum(isinstance(value, BaseException) for value in results)
            if failures:
                print(json.dumps({"type": "live-lab-cleanup-errors", "count": failures}), file=sys.stderr, flush=True)
                raise RuntimeError("Some owned live runtimes did not report clean shutdown")

    def _routes(self) -> None:
        app = self.app

        @app.get("/config")
        async def config():
            return {**self.configuration(), "runs": await self.observations()}

        @app.get("/sessions")
        async def sessions(request: Request):
            return await self.observations(request.url.hostname or "127.0.0.1")

        @app.get("/history")
        async def history_catalogue(provider: str):
            try:
                return await self.catalogue(provider)
            except (OSError, ValueError, RuntimeError) as error:
                raise HTTPException(409, str(error)) from None

        @app.get("/history/{provider}/{session_id}")
        async def saved_history(provider: str, session_id: str, cwd: str | None = None):
            try:
                return await self.history_choice(provider, session_id, cwd)
            except (OSError, ValueError, RuntimeError) as error:
                raise HTTPException(409, str(error)) from None

        @app.post("/sessions/end-all")
        async def end_all():
            return await self.end_all()

        @app.post("/sessions")
        async def start(request: Request, body: dict):
            try:
                return (await self.start(body)).public(request.url.hostname or "127.0.0.1")
            except (OSError, ValueError, RuntimeError) as error:
                raise HTTPException(400, str(error)) from None

        @app.post("/sessions/{identity}/identity")
        async def identify(identity: str, body: dict, request: Request):
            run = self.find(identity)
            thread = body.get("threadId")
            if not isinstance(thread, str) or not thread:
                raise HTTPException(422, "A native thread ID is required")
            async with run.lock:
                if run.thread_id and run.thread_id != thread:
                    raise HTTPException(409, "This run already belongs to a different native conversation")
                run.thread_id = thread
                await asyncio.to_thread(save, self.directory / "runs" / run.id / "run.json", await self.observe(run))
            return await self.observe(run, request.url.hostname or "127.0.0.1")

        @app.get("/sessions/{identity}/status")
        async def status(identity: str, request: Request):
            return await self.observe(self.find(identity), request.url.hostname or "127.0.0.1")

        @app.get("/sessions/{identity}/history")
        async def read_history(identity: str):
            run = self.find(identity)
            async with run.lock:
                try:
                    return await self.snapshot(run)
                except (ValueError, RuntimeError, OSError) as error:
                    raise HTTPException(409, str(error)) from None

        @app.post("/sessions/{identity}/capture")
        async def capture(identity: str, body: dict):
            run = self.find(identity)
            records = body.get("records")
            if not isinstance(records, list):
                raise HTTPException(422, "records must be a list of native client observations")
            async with run.lock:
                await asyncio.to_thread(
                    save,
                    self.directory / "runs" / run.id / "live.json",
                    {
                        "provider": run.provider,
                        "sessionId": run.thread_id,
                        "capturedAt": now(),
                        "records": records,
                    },
                )
            return {"saved": len(records)}

        @app.post("/sessions/{identity}/end")
        async def end(identity: str):
            return await self.end(self.find(identity))


async def main() -> None:
    lab = LiveLab()
    lab.prepare_workspace()
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", int(os.environ.get("PDUM_LIVE_LAB_PORT", "0"))))
    lab.port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(lab.app, log_level="error", access_log=False, timeout_graceful_shutdown=10))
    loop = asyncio.get_running_loop()
    watching_parent = False

    def parent_closed():
        if not os.read(sys.stdin.fileno(), 1):
            loop.remove_reader(sys.stdin.fileno())
            server.should_exit = True

    if not sys.stdin.isatty():
        try:
            loop.add_reader(sys.stdin.fileno(), parent_closed)
            watching_parent = True
        except (PermissionError, OSError):
            pass
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        while not server.started:
            if task.done():
                await task
                raise RuntimeError("Live session service stopped before readiness")
            await asyncio.sleep(0.02)
        print(
            json.dumps(
                {
                    "type": "live-lab-ready",
                    "pid": os.getpid(),
                    "url": f"http://127.0.0.1:{lab.port}",
                    "directory": str(lab.directory),
                }
            ),
            flush=True,
        )
        await task
    finally:
        if watching_parent:
            loop.remove_reader(sys.stdin.fileno())
        await lab.close()
        listener.close()


if __name__ == "__main__":
    asyncio.run(main())
