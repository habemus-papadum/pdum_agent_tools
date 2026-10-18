"""Prepare one eval run: a worktree off a base commit and an isolated agent profile.

Usage: prepare.py CONFIG.toml [--suffix r2] [--root ~/src/exp-evals] [--base main]

Writes ``run.json`` under the evals home and prints the run id. The user's own Codex and
Claude homes are only read (auth and config are copied into the profile), never changed.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from common import REPO_ROOT, load_config, now, run_dir, save_manifest, shell, task_dir, uv


def codex_profile(run_id: str, root: Path, worktree: Path, settings: dict) -> Path:
    profiles = root / "profiles"
    profiles.mkdir(parents=True, exist_ok=True)
    command = uv(
        "pdum-codex", "--profiles-dir", str(profiles), "profile", "create", run_id,
        "--from-codex-home", str(Path(settings.get("from_codex_home", "~/.codex")).expanduser()),
        "--copy-auth", "--model", settings["model"], "--no-interview",
    )  # fmt: skip
    if settings.get("clean", True):
        command += ["--marketplace", "none", "--plugin", "none", "--mcp-server", "none", "--skill", "none"]
    shell(command, cwd=REPO_ROOT)
    profile = profiles / run_id
    config = profile / "config.toml"
    text = config.read_text()
    # The imported config may carry a notify hook that opens a desktop app; drop it for a measured run.
    text = re.sub(r"^notify = \[.*?\]\n", "", text, flags=re.S | re.M)
    text = re.sub(r"^model_reasoning_effort = .*\n", "", text, flags=re.M)
    text = re.sub(r"^model_context_window = .*\n", "", text, flags=re.M)
    header = f'model = "{settings["model"]}"\nmodel_reasoning_effort = "{settings["reasoning_effort"]}"\n'
    if int(settings.get("model_context_window", 0)) > 0:
        header += f"model_context_window = {int(settings['model_context_window'])}\n"
    text = re.sub(r"^model = .*\n", header, text, count=1, flags=re.M)
    trust = f'\n[projects."{worktree}"]\ntrust_level = "trusted"\n'
    first_table = text.find("\n[")
    text = text + trust if first_table < 0 else text[:first_table] + trust + text[first_table:]
    config.write_text(text)
    return profile


def claude_profile(run_id: str, root: Path, worktree: Path, settings: dict) -> Path:
    profiles = root / "profiles"
    profiles.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(settings.get("settings", {}), handle, indent=2)
        native = handle.name
    shell(
        uv(
            "pdum-claude",
            "--profiles-dir",
            str(profiles),
            "profile",
            "create",
            run_id,
            "--workspace",
            str(worktree),
            "--auth",
            settings.get("auth", "reuse-login"),
            "--native-settings",
            native,
            "--setting-sources",
            settings.get("setting_sources", "user,project"),
            "--no-interview",
        ),  # fmt: skip
        cwd=REPO_ROOT,
    )
    Path(native).unlink(missing_ok=True)
    return profiles / run_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("config", type=Path)
    parser.add_argument("--suffix", default="", help="distinguishes repetitions, for example r2")
    parser.add_argument("--root", type=Path, default=Path("~/src/exp-evals"), help="worktrees and profiles go here")
    parser.add_argument("--base", default="main", help="commit or branch the worktree starts from")
    args = parser.parse_args()

    config = load_config(args.config)
    run = config["run"]
    task = task_dir(run["task"])
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    run_id = "-".join(part for part in (date, run["task"], run["label"], args.suffix) if part)
    root = args.root.expanduser()
    worktree = root / run_id
    if worktree.exists():
        raise SystemExit(f"{worktree} exists; pick another --suffix")
    root.mkdir(parents=True, exist_ok=True)
    shell(["git", "worktree", "add", "-q", str(worktree), "-b", f"eval/{run_id}", args.base], cwd=REPO_ROOT)

    agent = run["agent"]
    profile: Path | None = None
    if agent == "codex":
        profile = codex_profile(run_id, root, worktree, config["codex"])
    elif agent == "claude":
        profile = claude_profile(run_id, root, worktree, config["claude"])
    elif agent != "command":
        raise SystemExit(f"unknown agent kind {agent}")

    directory = run_dir(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copy(task / "prompt.txt", directory / "prompt.txt")
    shutil.copy(args.config, directory / "config.toml")
    save_manifest(
        {
            "run_id": run_id,
            "task": run["task"],
            "label": run["label"],
            "agent": agent,
            "config": config,
            "worktree": str(worktree),
            "profile": str(profile) if profile else None,
            "base": shell(["git", "rev-parse", args.base], cwd=REPO_ROOT).strip(),
            "created_at": now(),
        }
    )
    print(run_id)


if __name__ == "__main__":
    main()
