"""Prepare the bounded hp-mini task in a fresh scratch directory, without Git branches or credentials."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

EVALS = Path(__file__).resolve().parents[2] / "evals"
sys.path.insert(0, str(EVALS / "bin"))
from common import now, run_dir  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--agent", choices=["hp", "codex"], required=True)
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--effort", default="low")
    args = parser.parse_args()
    if Path(args.run_id).name != args.run_id or args.run_id in {".", ".."}:
        parser.error("run-id must be a single directory name")
    task = EVALS / "tasks" / "hp-mini"
    directory = run_dir(args.run_id)
    directory.mkdir(parents=True, exist_ok=False)
    worktree = directory / "worktree"
    shutil.copytree(task / "fixture", worktree)
    prompt = (task / "prompt.txt").read_bytes()
    (directory / "prompt.txt").write_bytes(prompt)
    manifest = {
        "run_id": args.run_id,
        "task": "hp-mini",
        "label": f"{args.agent}-{args.model}-{args.effort}",
        "agent": args.agent,
        "worktree": str(worktree),
        "profile": None,
        "created_at": now(),
        "root_thread_id": None,
        "prompt_sha256": hashlib.sha256(prompt).hexdigest(),
        "fixture_sha256": {
            str(file.relative_to(task / "fixture")): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted((task / "fixture").rglob("*"))
            if file.is_file()
        },
        "config": {
            "run": {"window": 272000},
            "model": args.model,
            "reasoning_effort": args.effort,
            "service_tier": "default",
            "sandbox": "off",
            "approvals": "off",
        },
        "execution": "not started; preparation makes no model requests",
    }
    (directory / "run.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        json.dumps(
            {
                "run_id": args.run_id,
                "run_dir": str(directory),
                "worktree": str(worktree),
                "prompt_file": str(directory / "prompt.txt"),
                "prompt_sha256": manifest["prompt_sha256"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
