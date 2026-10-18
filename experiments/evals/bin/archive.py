"""Register a run that was made by hand, so ingest.py and report.py can treat it like any other.

Usage: archive.py import --run-id ID --task TASK --label LABEL --agent codex|claude|command
                        --worktree PATH [--profile PATH] [--config CONFIG.toml]
                        [--started ISO] [--ended ISO] [--exit N] [--copy FILE ...]

``--copy`` files (event logs, result JSON, stderr, last message) land in the run directory under
their own names. Run ``ingest.py ID`` afterwards to snapshot transcripts and build the history.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from common import load_config, now, run_dir, save_manifest, task_dir


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["import"])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--agent", required=True, choices=["codex", "claude", "command"])
    parser.add_argument("--worktree", required=True, type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--config", type=Path, help="the config this run corresponds to")
    parser.add_argument("--started")
    parser.add_argument("--ended")
    parser.add_argument("--exit", type=int, dest="exit_code")
    parser.add_argument("--copy", nargs="*", type=Path, default=[])
    args = parser.parse_args()

    directory = run_dir(args.run_id)
    directory.mkdir(parents=True, exist_ok=True)
    task = task_dir(args.task)
    shutil.copy(task / "prompt.txt", directory / "prompt.txt")
    config = {}
    if args.config:
        config = load_config(args.config)
        shutil.copy(args.config, directory / "config.toml")
    for path in args.copy:
        shutil.copy(path, directory / path.name)
    started = args.started
    ended = args.ended
    seconds = None
    if started and ended:
        from common import parse_time

        seconds = round((parse_time(ended) - parse_time(started)).total_seconds())
    save_manifest(
        {
            "run_id": args.run_id,
            "task": args.task,
            "label": args.label,
            "agent": args.agent,
            "config": config,
            "worktree": str(args.worktree),
            "profile": str(args.profile) if args.profile else None,
            "base": None,
            "created_at": now(),
            "imported": True,
            "started_at": started,
            "ended_at": ended,
            "exit_code": args.exit_code,
            "seconds": seconds,
        }
    )
    print(args.run_id)


if __name__ == "__main__":
    main()
