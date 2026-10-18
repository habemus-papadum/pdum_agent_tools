"""Snapshot a run's raw data and ingest it into the shared schema.

Usage: ingest.py RUN_ID

Copies the agent's transcripts into ``raw/`` (a Codex home or Claude directory layout, so the
ingesters can read the archive without the profile), writes ``history.duckdb`` with
``pdum-history``, and saves the worktree's changes as ``worktree.patch`` plus ``status.txt``.
A ``command`` agent must have written ``history.duckdb`` in the shared schema itself, or named
the file to copy in its config as ``command.history``.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from common import REPO_ROOT, load_manifest, run_dir, shell, uv


def copy_tree(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)


def snapshot_codex(manifest: dict, directory: Path) -> Path:
    profile = Path(manifest["profile"])
    home = directory / "raw" / "codex-home"
    for name in ("sessions", "archived_sessions"):
        copy_tree(profile / name, home / name)
    for name in ("state_5.sqlite", "thread_history_1.sqlite", "logs_2.sqlite", "config.toml"):
        if (profile / name).exists():
            shutil.copy(profile / name, home / name)
    return home


def snapshot_claude(manifest: dict, directory: Path) -> Path:
    profile = Path(manifest["profile"])
    claude_dir = directory / "raw" / "claude-dir"
    copy_tree(profile / "claude" / "projects", claude_dir / "projects")
    if (profile / "claude" / "settings.json").exists():
        shutil.copy(profile / "claude" / "settings.json", claude_dir / "settings.json")
    return claude_dir


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    manifest = load_manifest(sys.argv[1])
    directory = run_dir(manifest["run_id"])
    db = directory / "history.duckdb"
    agent = manifest["agent"]
    if agent == "codex":
        home = snapshot_codex(manifest, directory)
        db.unlink(missing_ok=True)
        shell(
            uv("pdum-history", "ingest", "codex", "--home", str(home), "--db", str(db), "--window-days", "0"),
            cwd=REPO_ROOT,
        )
    elif agent == "claude":
        claude_dir = snapshot_claude(manifest, directory)
        db.unlink(missing_ok=True)
        shell(
            uv(
                "pdum-history",
                "ingest",
                "claude",
                "--claude-dir",
                str(claude_dir),
                "--db",
                str(db),
                "--window-days",
                "0",
            ),
            cwd=REPO_ROOT,
        )
    else:
        source = manifest["config"].get("command", {}).get("history")
        if source:
            shutil.copy(Path(source.format(run_dir=str(directory), worktree=manifest["worktree"])).expanduser(), db)
        if not db.exists():
            sys.exit(f"{db} missing: a command agent must write its history in the shared schema")

    worktree = Path(manifest["worktree"])
    if worktree.is_dir():
        shell(["git", "add", "-A"], cwd=worktree)
        (directory / "worktree.patch").write_text(shell(["git", "diff", "--cached", "--binary"], cwd=worktree))
        (directory / "status.txt").write_text(shell(["git", "status", "--short"], cwd=worktree))
        shell(["git", "reset", "-q"], cwd=worktree)
    print(f"{manifest['run_id']}: history at {db}")


if __name__ == "__main__":
    main()
