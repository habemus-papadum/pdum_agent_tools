from __future__ import annotations

import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import tomllib
from pathlib import Path

import pytest


class Terminal:
    def __init__(self, descriptor: int, process: subprocess.Popen):
        self.descriptor = descriptor
        self.process = process
        self.transcript = bytearray()
        self.pending = bytearray()
        self.deadline = time.monotonic() + 25

    def read(self) -> bool:
        if not select.select([self.descriptor], [], [], 0.1)[0]:
            return False
        try:
            chunk = os.read(self.descriptor, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        self.transcript.extend(chunk)
        self.pending.extend(chunk)
        return bool(chunk)

    def answer(self, message: str, keys: bytes):
        while time.monotonic() < self.deadline:
            self.read()
            rendered = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", self.pending).decode(errors="replace")
            if message in rendered:
                self.pending.clear()
                os.write(self.descriptor, keys)
                return
            if self.process.poll() is not None:
                break
        raise AssertionError(f"Terminal did not show {message!r}: {self.transcript.decode(errors='replace')}")

    def finish(self):
        while time.monotonic() < self.deadline:
            self.read()
            if self.process.poll() is not None:
                while self.read():
                    pass
                assert self.process.returncode == 0, self.transcript.decode(errors="replace")
                return
        raise AssertionError(f"CLI did not finish: {self.transcript.decode(errors='replace')}")


def run_interview(
    tmp_path: Path,
    selection: str,
    *,
    federation: bool = False,
) -> tuple[dict, str]:
    source = tmp_path / "native"
    source.mkdir()
    native = (
        'profile="work"\nmodel="gpt-6-luna"\nunknown_setting="keep"\n'
        '[profiles.work]\nmodel="gpt-6-sol"\n'
        '[mcp_servers.one]\ncommand="one"\n[mcp_servers.two]\ncommand="two"\n'
    )
    (source / "config.toml").write_text(native)
    home = tmp_path / "home"
    home.mkdir()
    destination = tmp_path / "profile"
    command = [
        sys.executable,
        "-m",
        "pdum.codex_launcher",
        "--profile-dir",
        str(destination),
        "profile",
        "create",
        "--from-codex-home",
        str(source),
        "--executable",
        sys.executable,
        "--interview",
    ]
    if federation:
        command.extend(["--auth", "aws-federation"])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 180, 0, 0))
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "CODEX_HOME": str(source),
        "TERM": "xterm-256color",
        "PROMPT_TOOLKIT_NO_CPR": "1",
        "PYTHONUNBUFFERED": "1",
    }
    process = None
    try:
        process = subprocess.Popen(
            command,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=environment,
            cwd=tmp_path,
            start_new_session=True,
        )
        os.close(slave)
        slave = -1
        terminal = Terminal(master, process)
        keys = {"all": b"\r", "none": b"\x1b[B\r", "individual": b"\x1b[B\x1b[B\r"}[selection]
        terminal.answer("Import MCP servers (2 available)?", keys)
        if selection == "individual":
            terminal.answer("Select MCP servers (Space toggles, Enter accepts)", b"\x1b[B \r")
        terminal.answer("Model (blank preserves the native setting)", b"\r")
        terminal.answer("Codex executable", b"\r")
        terminal.answer("Authentication method", b"\r" if federation else b"\x1b[B\r")
        if federation:
            terminal.answer("AWS region", b"\r")
            terminal.answer("AWS profile (blank uses the native credential chain)", b"fixture\r")
            terminal.answer("OpenAI identity-provider ID", b"test-idp\r")
            terminal.answer("OpenAI service-account ID", b"test-service\r")
            terminal.answer("Audience", b"\r")
            terminal.answer("AWS home (configuration and login caches)", b"\r")
            terminal.answer("AWS login command", b"\r")
            terminal.answer("Edit advanced AWS/helper settings?", b"\r")
            terminal.answer("Responses API base URL (blank uses OpenAI)", b"\r")
        terminal.answer("Run the selected login flow after saving?", b"\r")
        terminal.answer("Remaining configuration", b"\r")
        terminal.answer("Save this profile configuration?", b"\r")
        terminal.finish()
        assert (source / "config.toml").read_text() == native
        assert not (destination / "codex/auth.json").exists()
        return tomllib.loads((destination / "codex/config.toml").read_text()), terminal.transcript.decode(
            errors="replace"
        )
    finally:
        if slave != -1:
            os.close(slave)
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        os.close(master)


@pytest.mark.parametrize("selection, expected", [("all", {"one", "two"}), ("none", set()), ("individual", {"one"})])
def test_actual_terminal_interview_saves_selections(tmp_path: Path, selection: str, expected: set[str]):
    native, transcript = run_interview(tmp_path, selection)
    assert set(native.get("mcp_servers", {})) == expected
    assert native["unknown_setting"] == "keep"
    assert "profile" not in native
    assert native["profiles"]["work"]["model"] == "gpt-6-sol"
    assert "Active native profile:" in transcript


def test_actual_terminal_fills_incomplete_federation_flags_before_validation(tmp_path: Path):
    native, _ = run_interview(tmp_path, "none", federation=True)
    provider = native["model_providers"][native["model_provider"]]
    assert "pdum.codex_launcher._federation_helper" in provider["auth"]["args"]
    assert provider["supports_websockets"]
    metadata = tomllib.loads((tmp_path / "profile/launcher.toml").read_text())
    assert metadata["authentication"]["federation"]["identity_provider_id"] == "test-idp"
    assert metadata["authentication"]["federation"]["service_account_id"] == "test-service"
