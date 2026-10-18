"""Run one prepared eval: a single non-interactive turn of the configured agent in its worktree.

Usage: run.py RUN_ID

Codex runs through ``codex exec`` with the profile as CODEX_HOME. Claude runs through
``claude -p`` with the launcher's environment for the profile, which carries the borrowed login
without ever writing it to a log. A ``command`` agent runs its template with ``{worktree}``,
``{prompt}``, ``{prompt_file}`` and ``{run_dir}`` substituted. Timing and exit code land in run.json.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

from common import load_manifest, now, run_dir, save_manifest


def codex_command(manifest: dict, prompt: str, directory: Path) -> tuple[list[str], dict[str, str]]:
    env = dict(os.environ, CODEX_HOME=manifest["profile"])
    command = [
        "codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
        "-C", manifest["worktree"], "--json", "-o", str(directory / "last-message.md"), prompt,
    ]  # fmt: skip
    return command, env


def claude_command(manifest: dict, prompt: str) -> tuple[list[str], dict[str, str]]:
    from pdum.claude_launcher.authentication import build_environment
    from pdum.claude_launcher.profiles import load_profile

    env = asyncio.run(build_environment(load_profile(Path(manifest["profile"]))))
    command = ["claude", "-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json"]
    return command, env


def custom_command(manifest: dict, prompt: str, directory: Path) -> tuple[list[str], dict[str, str]]:
    template = manifest["config"]["command"]["run"]
    rendered = template.format(
        worktree=manifest["worktree"],
        prompt=shlex.quote(prompt),
        prompt_file=str(directory / "prompt.txt"),
        run_dir=str(directory),
    )
    env = dict(os.environ, EVAL_RUN_DIR=str(directory), EVAL_WORKTREE=manifest["worktree"])
    return ["/bin/zsh", "-c", rendered], env


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    manifest = load_manifest(sys.argv[1])
    directory = run_dir(manifest["run_id"])
    prompt = (directory / "prompt.txt").read_text()
    agent = manifest["agent"]
    if agent == "codex":
        command, env = codex_command(manifest, prompt, directory)
        stdout_name = "events.jsonl"
    elif agent == "claude":
        command, env = claude_command(manifest, prompt)
        stdout_name = "result.json"
    else:
        command, env = custom_command(manifest, prompt, directory)
        stdout_name = "stdout.log"

    manifest["started_at"] = now()
    save_manifest(manifest)
    started = time.time()
    with (directory / stdout_name).open("w") as stdout, (directory / "stderr.log").open("w") as stderr:
        code = subprocess.run(command, cwd=manifest["worktree"], env=env, stdout=stdout, stderr=stderr).returncode
    manifest["ended_at"] = now()
    manifest["exit_code"] = code
    manifest["seconds"] = round(time.time() - started)
    save_manifest(manifest)
    print(f"{manifest['run_id']}: exit {code} after {manifest['seconds']} s")


if __name__ == "__main__":
    main()
