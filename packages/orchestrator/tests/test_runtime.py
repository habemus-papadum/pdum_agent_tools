"""Ownership metadata and inert construction use no provider processes."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pdum.orchestrator import Coordinator, CoordinatorError, InstanceMismatchError, StateDirectoryError


async def test_two_library_owners_have_separate_state_and_targeted_stop(tmp_path: Path) -> None:
    first_path, second_path = tmp_path / "first", tmp_path / "second"
    async with Coordinator(state_directory=first_path, workspace_directory=tmp_path) as first:
        async with Coordinator(state_directory=second_path, workspace_directory=tmp_path) as second:
            first_status, second_status = first.status(), second.status()
            assert first_status["instanceId"] != second_status["instanceId"]
            assert first_status["stateDirectory"] != second_status["stateDirectory"]
            assert set(first_status["capabilities"]) == {"status", "runs", "stop"}
            assert first.list_runs() == []
            assert first_status["pid"] == os.getpid()
            assert first_status["processStartedAt"] > 0
            for path in first_status["profileRoots"].values():
                assert Path(path).is_relative_to(first_path)
                assert list(Path(path).iterdir()) == []
            with pytest.raises(InstanceMismatchError):
                first.request_stop(second.instance_id)
            assert first.status()["state"] == "running"
            first.request_stop(first.instance_id)
            await asyncio.wait_for(first.wait_for_stop(), 1)
            assert first.status()["state"] == "stopping"
            assert second.status()["state"] == "running"
    for path in (first_path, second_path):
        record = json.loads((path / "instance.json").read_text())
        assert record["state"] == "stopped"
        assert record["stoppedAt"] is not None


async def test_existing_state_is_never_adopted_or_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "existing"
    owner = Coordinator(state_directory=path)
    await owner.start()
    try:
        before = (path / "instance.json").read_bytes()
        with pytest.raises(StateDirectoryError):
            await Coordinator(state_directory=path).start()
        assert (path / "instance.json").read_bytes() == before
        assert owner.status()["state"] == "running"
    finally:
        await owner.close()
    with pytest.raises(StateDirectoryError):
        await Coordinator(state_directory=path).start()
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(StateDirectoryError):
        await Coordinator(state_directory=empty).start()


async def test_invalid_workspace_does_not_allocate_state(tmp_path: Path) -> None:
    owner = Coordinator(state_directory=tmp_path / "new", workspace_directory=tmp_path / "absent")
    with pytest.raises(FileNotFoundError):
        await owner.start()
    assert not (tmp_path / "new").exists()
    await owner.close()
    with pytest.raises(CoordinatorError):
        owner.status()


async def test_close_does_not_overwrite_a_replaced_owner_record(tmp_path: Path) -> None:
    owner = await Coordinator(state_directory=tmp_path / "owned").start()
    path = owner.state_directory / "instance.json"
    replacement = {"instanceId": "another-owner", "state": "running"}
    path.write_text(json.dumps(replacement))
    with pytest.raises(StateDirectoryError, match="another owner"):
        await owner.close()
    assert json.loads(path.read_text()) == replacement


def test_import_and_cli_app_construction_are_inert(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "src"
    environment = {**os.environ, "PYTHONPATH": str(source), "PROBE_DIRECTORY": str(tmp_path)}
    program = """
import os, signal, socket, subprocess
from pathlib import Path
root = Path(os.environ['PROBE_DIRECTORY'])
before = {s: signal.getsignal(s) for s in [signal.SIGINT, signal.SIGTERM]}
class NoSpawn(subprocess.Popen):
    def __init__(self, *a, **k): raise AssertionError('import spawned a process')
class NoBind(socket.socket):
    def bind(self, *a, **k): raise AssertionError('import bound a listener')
subprocess.Popen = NoSpawn
socket.socket = NoBind
from pdum.orchestrator import Coordinator
from pdum.orchestrator.cli import create_cli
from pdum.orchestrator.management import create_app
owner = Coordinator(state_directory=root / 'unstarted')
create_cli()
create_app(owner)
assert not (root / 'unstarted').exists()
assert before == {s: signal.getsignal(s) for s in before}
"""
    result = subprocess.run(
        [sys.executable, "-c", program], cwd=tmp_path, env=environment, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
