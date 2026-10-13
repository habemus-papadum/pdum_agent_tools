"""Mounting, profile setup, and cancellation through the public Typer interface."""

import json
import subprocess
import sys
from types import SimpleNamespace

import pytest
import typer
from pdum.claude_launcher import cli
from pdum.claude_launcher.cli import create_app
from typer.testing import CliRunner


def test_import_and_mount_do_not_start_processes_or_install_signal_handlers(tmp_path):
    script = """
import asyncio
import signal
import subprocess
def forbidden(*args, **kwargs):
    raise AssertionError('Import or mounting performed a runtime operation')
asyncio.create_subprocess_exec = forbidden
subprocess.Popen = forbidden
signal.signal = forbidden
import typer
from pdum.claude_launcher.cli import app, create_app
parent = typer.Typer()
parent.add_typer(app, name='claude')
parent.add_typer(create_app(), name='another')
print('mounted')
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=tmp_path, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "mounted"


def test_mountable_cli_and_factory_independence(tmp_path):
    first = create_app()
    first.command("custom")(lambda: typer.echo("extension"))
    parent = typer.Typer()
    parent.add_typer(first, name="claude")
    runner = CliRunner()
    result = runner.invoke(parent, ["claude", "--profiles-dir", str(tmp_path), "profile", "list", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == []
    assert runner.invoke(parent, ["claude", "custom"]).stdout.strip() == "extension"
    assert runner.invoke(create_app(), ["custom"]).exit_code != 0


def test_profile_create_show_list_preserves_native_source_and_keeps_auth_as_reference(tmp_path, monkeypatch):
    root = tmp_path / "profiles"
    source = tmp_path / "settings.json"
    original = b'{ "future": {"provider-option": [1, true]}, "model": "native-model" }\n'
    source.write_bytes(original)
    monkeypatch.setenv("MY_CLAUDE_KEY", "synthetic-value-never-saved")
    runner = CliRunner()
    app = create_app()
    result = runner.invoke(
        app,
        [
            "--profiles-dir",
            str(root),
            "profile",
            "create",
            "example",
            "--workspace",
            str(tmp_path),
            "--model",
            "haiku",
            "--auth",
            "api-key",
            "--api-key-env",
            "MY_CLAUDE_KEY",
            "--setting-sources",
            "user",
            "--native-settings",
            str(source),
            "--no-interview",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "synthetic-value-never-saved" not in result.output
    description = json.loads(result.stdout)
    assert description["authentication"]["api_key_env"] == "MY_CLAUDE_KEY"
    assert description["setting_sources"] == ["user"]
    assert description["workspace"] == str(tmp_path)
    assert (root / "example/claude/settings.json").read_bytes() == original
    assert source.read_bytes() == original
    result = runner.invoke(app, ["--profiles-dir", str(root), "--profile", "example", "profile", "show"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == description
    result = runner.invoke(app, ["--profiles-dir", str(root), "profile", "list", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == [description]
    result = runner.invoke(app, ["--profiles-dir", str(root), "profile", "list"])
    assert result.exit_code == 0, result.output
    assert "example" in result.stdout
    for path in (root / "example").rglob("*"):
        if path.is_file():
            assert "synthetic-value-never-saved" not in path.read_text()


def test_explicit_directory_uses_invocation_working_directory(tmp_path, monkeypatch):
    app = create_app()
    monkeypatch.chdir(tmp_path)
    profile = tmp_path / "profile"
    result = CliRunner().invoke(app, ["--profile-dir", str(profile), "profile", "create", "--no-interview"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["workspace"] == str(tmp_path)


@pytest.mark.parametrize(
    "flags",
    [
        ["--auth", "unsupported"],
        ["--auth", "api-key", "--api-key-env", "not an environment variable"],
        ["--auth", "native", "--source-directory", "/not/a/login-source"],
        ["--setting-sources", "unexpected-scope"],
        ["--setting-sources", "user,user"],
        ["--auth", "api-key", "--login"],
        ["--auth", "reuse-login", "--login"],
    ],
)
def test_invalid_creation_flags_do_not_write_profile(tmp_path, flags):
    profile = tmp_path / "profile"
    result = CliRunner().invoke(
        create_app(),
        ["--profile-dir", str(profile), "profile", "create", "--workspace", str(tmp_path), "--no-interview", *flags],
    )
    assert result.exit_code != 0
    assert result.output.strip()
    assert not profile.exists()


@pytest.mark.parametrize("command", [["profile", "show"], ["auth", "status"], ["auth", "login"], ["sessions", "list"]])
def test_missing_profile_selection_produces_actionable_error(command):
    result = CliRunner().invoke(create_app(), command)
    assert result.exit_code != 0
    assert "profile" in result.output.lower()
    assert "traceback" not in result.output.lower()
    assert isinstance(result.exception, SystemExit)


@pytest.mark.parametrize("command", [["profile", "list", "--json"], ["profile", "show"], ["auth", "status"]])
def test_conflicting_profile_selectors_are_rejected_for_read_operations(tmp_path, command):
    result = CliRunner().invoke(
        create_app(), ["--profile-dir", str(tmp_path), "--profiles-dir", str(tmp_path), *command]
    )
    assert result.exit_code != 0
    assert "cannot be combined" in result.output
    assert isinstance(result.exception, SystemExit)


def test_malformed_listed_profile_is_an_actionable_error(tmp_path):
    root = tmp_path / "profiles"
    broken = root / "broken"
    broken.mkdir(parents=True)
    (broken / "profile.json").write_text("not JSON")
    result = CliRunner().invoke(create_app(), ["--profiles-dir", str(root), "profile", "list", "--json"])
    assert result.exit_code != 0
    assert "malformed" in result.output
    assert isinstance(result.exception, SystemExit)


@pytest.mark.parametrize("cancel_at", ["authentication", "model", "sources", "confirm"])
def test_interview_cancellation_at_any_stage_leaves_no_profile_or_login(tmp_path, monkeypatch, cancel_at):
    monkeypatch.setattr(
        cli,
        "sys",
        SimpleNamespace(stdin=SimpleNamespace(isatty=lambda: True), stdout=SimpleNamespace(isatty=lambda: True)),
    )
    monkeypatch.setattr(
        cli.questionary,
        "select",
        lambda *_args, **_kwargs: SimpleNamespace(ask=lambda: None if cancel_at == "authentication" else "native"),
    )
    monkeypatch.setattr(
        cli.questionary,
        "text",
        lambda *_args, **_kwargs: SimpleNamespace(ask=lambda: None if cancel_at == "model" else "haiku"),
    )
    monkeypatch.setattr(
        cli.questionary,
        "checkbox",
        lambda *_args, **_kwargs: SimpleNamespace(ask=lambda: None if cancel_at == "sources" else ["user"]),
    )
    monkeypatch.setattr(cli.questionary, "confirm", lambda *_args, **_kwargs: SimpleNamespace(ask=lambda: None))

    async def forbidden_login(*_args):
        raise AssertionError("Cancelling the interview must not start login")

    monkeypatch.setattr(cli, "login_auth", forbidden_login)
    profile = tmp_path / "profiles" / "cancelled"
    result = CliRunner().invoke(
        create_app(), ["--profile-dir", str(profile), "profile", "create", "--workspace", str(tmp_path), "--login"]
    )
    assert result.exit_code == 0, result.output
    assert not profile.parent.exists()


def test_native_login_runs_only_after_profile_save(tmp_path):
    executable = tmp_path / "native-login-fixture"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, sys\n"
        "root = pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])\n"
        "assert (root.parent / 'profile.json').is_file()\n"
        "assert (root / 'settings.json').is_file()\n"
        "assert sys.argv[-3:] == ['auth', 'login', '--claudeai']\n"
        "(root / 'login-executed').write_text('ok')\n"
    )
    executable.chmod(0o700)
    profile = tmp_path / "profile"
    result = CliRunner().invoke(
        create_app(),
        [
            "--profile-dir",
            str(profile),
            "profile",
            "create",
            "--workspace",
            str(tmp_path),
            "--executable",
            str(executable),
            "--no-interview",
            "--login",
        ],
    )
    assert result.exit_code == 0, result.output
    assert (profile / "claude/login-executed").read_text() == "ok"
