"""Shared helpers for the agent eval scripts: paths, manifests, subprocesses."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = EVALS_DIR.parent.parent


def evals_home() -> Path:
    """Where runs keep their raw data: ``$EVALS_HOME`` or ``~/history/evals``; outside any checkout."""
    return Path(os.environ.get("EVALS_HOME") or Path.home() / "history" / "evals").expanduser()


def run_dir(run_id: str) -> Path:
    return evals_home() / run_id


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_config(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        return tomllib.load(stream)


def load_manifest(run_id: str) -> dict[str, Any]:
    path = run_dir(run_id) / "run.json"
    if not path.exists():
        sys.exit(f"no run {run_id} under {evals_home()} (expected {path})")
    return json.loads(path.read_text())


def save_manifest(manifest: dict[str, Any]) -> None:
    directory = run_dir(manifest["run_id"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "run.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def shell(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None, check: bool = True) -> str:
    """Run a command and return its stdout; print stderr on failure."""
    completed = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if check and completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise SystemExit(f"command failed ({completed.returncode}): {' '.join(command)}")
    return completed.stdout


def task_dir(task: str) -> Path:
    directory = EVALS_DIR / "tasks" / task
    if not directory.is_dir():
        sys.exit(f"unknown task {task}; expected {directory}")
    return directory


def uv(*args: str) -> list[str]:
    """A ``uv run`` command line against this repository's locked environment."""
    return ["uv", "run", "--frozen", "--all-packages", "--project", str(REPO_ROOT), *args]
