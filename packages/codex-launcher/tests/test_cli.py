import json
import sys

import typer
from pdum.codex_launcher.cli import create_app
from typer.testing import CliRunner


def test_standalone_profile_create_show_and_dry_run(tmp_path):
    runner = CliRunner()
    app = create_app()
    prefix = ["--profiles-dir", str(tmp_path)]
    result = runner.invoke(app, [*prefix, "profile", "create", "example", "--executable", sys.executable])
    assert result.exit_code == 0, result.output
    result = runner.invoke(app, [*prefix, "--profile", "example", "profile", "show"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["directory"] == str((tmp_path / "example").resolve())
    result = runner.invoke(app, [*prefix, "--profile", "example", "launch", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["host"] == "0.0.0.0"
    assert not (tmp_path / "example/runtime/owner.json").exists()


def test_mountable_cli_and_factory_independence(tmp_path):
    parent = typer.Typer()
    parent.add_typer(create_app(), name="codex")
    runner = CliRunner()
    result = runner.invoke(parent, ["codex", "--profiles-dir", str(tmp_path), "profile", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == []
    extended = create_app([lambda app: app.command("custom")(lambda: typer.echo("custom"))])
    assert runner.invoke(extended, ["custom"]).exit_code == 0
    assert runner.invoke(create_app(), ["custom"]).exit_code != 0


def test_duplicate_extension_commands_fail():
    try:
        create_app([lambda app: app.command("launch")(lambda: None)])
    except ValueError as error:
        assert "conflicting" in str(error)
    else:
        raise AssertionError("Duplicate command accepted")


def test_conflicting_selectors_and_missing_profile_are_actionable(tmp_path):
    runner = CliRunner()
    app = create_app()
    result = runner.invoke(app, ["--profile-dir", str(tmp_path), "--profile", "other", "status"])
    assert result.exit_code != 0
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 1
    assert "Select --profile" in result.output
