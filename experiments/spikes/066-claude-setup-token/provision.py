"""Operator-run native token setup. Credential values never enter the experiment report."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import questionary

ROOT = Path(__file__).resolve().parents[3]
STATE = ROOT / "experiments/artifacts/066-claude-setup-token"


def read_token(*, clipboard: bool = False) -> str:
    """Read clipboard text on request, or use a paste-friendly masked prompt."""
    if clipboard:
        if sys.platform != "darwin":
            raise SystemExit("--clipboard currently supports macOS; use the masked prompt on other systems.")
        try:
            completed = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, text=True, check=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            raise SystemExit("Could not read the clipboard; nothing was stored.") from None
        value = completed.stdout
        if not value.strip().startswith("sk-ant-oat01-"):
            raise SystemExit("Clipboard does not contain a Claude OAuth token; nothing was stored.")
    else:
        value = questionary.password("Generated setup token (paste, then Enter):").ask()
        if value is None:
            raise SystemExit("Cancelled; nothing was stored.")
    token = value.strip()
    if not token or any(char.isspace() for char in token) or "\x00" in token:
        raise SystemExit("Expected one nonempty token without whitespace; nothing was stored.")
    return token


def main() -> None:
    """Let the operator authorize Claude, then store the printed token locally."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true", help="Replace the experiment's stored token after new input")
    parser.add_argument(
        "--paste-only", action="store_true", help="Paste an already-generated token without opening login"
    )
    parser.add_argument(
        "--clipboard", action="store_true", help="Read the token from the macOS clipboard; skips login and the prompt"
    )
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = STATE / "setup-token.txt"
    if target.exists() and not args.replace:
        raise SystemExit(f"Token file already exists: {target}. Use --replace to explicitly replace it.")
    issuer = STATE / "issuer"
    issuer.mkdir(mode=0o700, exist_ok=True)
    workspace = STATE / "issuer-workspace"
    workspace.mkdir(exist_ok=True)
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith(("CLAUDE_", "CLAUDECODE", "ANTHROPIC_"))
    }
    environment.update(
        CLAUDE_CONFIG_DIR=str(issuer),
        ANTHROPIC_CONFIG_DIR=str(STATE / "issuer-anthropic"),
        DISABLE_AUTOUPDATER="1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
    )
    if not (args.paste_only or args.clipboard):
        print("Claude will open its browser authorization flow using a separate experiment config directory.")
        print("The native command prints your token in this terminal. Copy it, then paste at the masked prompt below.")
        completed = subprocess.run(["claude", "setup-token"], cwd=workspace, env=environment, check=False)
        if completed.returncode:
            raise SystemExit(f"Native setup-token exited with status {completed.returncode}; nothing was stored.")
    token = read_token(clipboard=args.clipboard)
    destination = target.with_name(f".setup-token-{os.getpid()}.tmp") if args.replace else target
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(token + "\n")
        if args.replace:
            destination.replace(target)
    finally:
        if args.replace:
            destination.unlink(missing_ok=True)
    print(f"Saved the token to {target}. Reply 'ready' in the agent conversation; do not paste the token there.")


if __name__ == "__main__":
    main()
