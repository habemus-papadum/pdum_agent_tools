"""CLI subprocess checks, including pipe lifetime across detached launch."""

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

from hostfork_spike import status_at, stop_at


def invoke(root: Path, *arguments: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "hostfork_spike", "run", "--artifacts", str(root), *arguments],
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_cli_propagates_command_error_and_preserves_logs(tmp_path: Path) -> None:
    result = invoke(tmp_path, "--logs", "--deadline", "5", "--", "/bin/sh", "-c", "echo partial; exit 7")
    assert result.returncode == 7, result.stderr
    environment_path = next(tmp_path.glob("env-*"))
    state = json.loads((environment_path / "state.json").read_text())
    assert state["state"] == "closed"
    command = next(iter(state["processes"].values()))
    assert Path(command["stdout_path"]).read_text() == "partial\n"


def test_cli_deadline_exit_status(tmp_path: Path) -> None:
    result = invoke(tmp_path, "--deadline", "0.3", "--", "/bin/sleep", "99")
    assert result.returncode == 124, result.stderr


def test_detach_returns_before_deadline_and_releases_captured_pipes(tmp_path: Path) -> None:
    started = time.monotonic()
    result = invoke(tmp_path, "--detach", "--deadline", "3", "--", "/bin/sleep", "99")
    elapsed = time.monotonic() - started
    environment_path = next(tmp_path.glob("env-*"))
    try:
        assert result.returncode == 0, result.stderr
        assert elapsed < 2, "Detached helper kept caller's output pipe open"
        state = asyncio.run(status_at(environment_path))
        assert state["state"] == "running"
    finally:
        asyncio.run(stop_at(environment_path))
