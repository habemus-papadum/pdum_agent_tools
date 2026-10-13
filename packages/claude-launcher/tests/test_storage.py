"""Real public-SDK filesystem calls over isolated helper subprocesses.

Transcripts here are synthetic parser fixtures, not claimed model responses.
The SDK itself implements every listing, read, rename and fork operation.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from pdum.claude_launcher.profiles import Profile, create_profile
from pdum.claude_launcher.storage import History, HistoryError


def _fixture(profile: Profile, label: str, *, session_id: str | None = None) -> tuple[str, list[str], Path]:
    session_id = session_id or str(uuid4())
    message_ids = [str(uuid4()) for _ in range(4)]
    project = profile.config_directory / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", str(profile.workspace))
    project.mkdir(parents=True, exist_ok=True)
    transcript = project / f"{session_id}.jsonl"
    rows = []
    for index, message_id in enumerate(message_ids):
        role = "user" if index % 2 == 0 else "assistant"
        rows.append(
            {
                "type": role,
                "uuid": message_id,
                "parentUuid": message_ids[index - 1] if index else None,
                "sessionId": session_id,
                "cwd": str(profile.workspace),
                "timestamp": f"2026-10-13T12:00:0{index}Z",
                "isSidechain": False,
                "userType": "external",
                "version": "2.1.296",
                "message": {"role": role, "content": f"{label} message {index}"},
            }
        )
    transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
    return session_id, message_ids, transcript


async def test_concurrent_profiles_share_workspace_without_history_leakage(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    first = create_profile(tmp_path / "a", workspace=workspace)
    second = create_profile(tmp_path / "b", workspace=workspace)
    session_id, _, _ = _fixture(first, "ALPHA")
    _fixture(second, "BETA", session_id=session_id)
    parent_environment = os.environ.get("CLAUDE_CONFIG_DIR")

    async with History(first) as a, History(second) as b:
        a_list, b_list = await asyncio.gather(a.list(), b.list())
        assert len(a_list) == len(b_list) == 1
        assert a_list[0]["first_prompt"] == "ALPHA message 0"
        assert b_list[0]["first_prompt"] == "BETA message 0"
        assert a.pid is not None and b.pid is not None and a.pid != b.pid
        first_messages, second_messages = await asyncio.gather(a.read(session_id), b.read(session_id))
        assert first_messages[0]["message"]["content"] == "ALPHA message 0"
        assert second_messages[0]["message"]["content"] == "BETA message 0"
        await a.rename(session_id, "Changed only in A")
        assert (await a.info(session_id))["custom_title"] == "Changed only in A"
        assert (await b.info(session_id))["custom_title"] is None
        assert await a.list(limit=1, offset=1) == []

    assert os.environ.get("CLAUDE_CONFIG_DIR") == parent_environment


async def test_fork_at_selected_message_preserves_source_and_profile(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=workspace)
    other = create_profile(tmp_path / "other", workspace=workspace)
    session_id, message_ids, transcript = _fixture(profile, "SOURCE")
    original = transcript.read_bytes()

    async with History(profile) as history, History(other) as isolated:
        fork = await history.fork(session_id, title="Selected fork", up_to_message_id=message_ids[1])
        assert fork["session_id"] != session_id
        assert transcript.read_bytes() == original
        assert len(await history.read(session_id)) == 4
        assert len(await history.read(fork["session_id"])) == 2
        assert (await history.info(fork["session_id"]))["custom_title"] == "Selected fork"
        assert [item["uuid"] for item in await history.read(session_id, offset=1, limit=2)] == message_ids[1:3]
        assert await isolated.info(session_id) is None
        assert await isolated.read(session_id) == []
        assert await isolated.list() == []
        with pytest.raises(FileNotFoundError):
            await isolated.fork(session_id)
        with pytest.raises(ValueError):
            await history.rename(session_id, " ")
        with pytest.raises(ValueError):
            await history.fork(session_id, up_to_message_id=str(uuid4()))
        with pytest.raises(ValueError):
            await history.fork(session_id, up_to_message_id="not-a-message-id")
        assert len(await history.list()) == 2
        assert transcript.read_bytes() == original


async def test_history_keeps_large_sdk_responses_intact_and_close_reaps_helper(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=workspace)
    session_id, _, _ = _fixture(profile, "Z" * 180_000)
    history = History(profile)
    assert not history.closed
    messages = await history.read(session_id)
    assert len(messages) == 4
    assert messages[3]["message"]["content"] == "Z" * 180_000 + " message 3"
    process = history._process
    assert process is not None and process.returncode is None
    await history.close()
    await history.close()
    assert process.returncode == 0
    assert history.closed
    with pytest.raises(HistoryError, match="closed"):
        await history.list()


async def test_helper_exit_is_reported_without_silent_restart(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=workspace)
    async with History(profile) as history:
        assert await history.list() == []
        process = history._process
        assert process is not None
        process.kill()
        await process.wait()
        assert history.closed
        with pytest.raises(HistoryError, match="exited"):
            await history.list()


@pytest.mark.parametrize("cancel", [True, False])
async def test_abandoned_request_reaps_stalled_helper_and_prevents_response_mixup(tmp_path: Path, cancel: bool) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=workspace)
    async with History(profile, operation_timeout=None if cancel else 0.02) as history:
        # Inject a genuinely unresponsive child, not a mocked SDK success. It
        # ignores stdin EOF so cancellation must escalate to process cleanup.
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-c",
            "import time; time.sleep(60)",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        history._process = process
        pending = asyncio.create_task(history.list())
        if cancel:
            await asyncio.sleep(0.02)
            pending.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
            await pending
        assert process.returncode is not None
        assert history.closed
        with pytest.raises(HistoryError, match="closed"):
            await history.list()
