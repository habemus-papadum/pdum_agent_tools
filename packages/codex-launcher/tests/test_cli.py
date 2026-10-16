import json
import sys
import tomllib

import typer
from pdum.codex_launcher.cli import create_app
from typer.testing import CliRunner


def test_standalone_profile_create_show_and_dry_run(tmp_path):
    runner = CliRunner()
    app = create_app()
    prefix = ["--profiles-dir", str(tmp_path)]
    result = runner.invoke(
        app, [*prefix, "profile", "create", "example", "--executable", sys.executable, "--clean", "--no-interview"]
    )
    assert result.exit_code == 0, result.output
    result = runner.invoke(app, [*prefix, "--profile", "example", "profile", "show"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["directory"] == str((tmp_path / "example").resolve())
    result = runner.invoke(app, [*prefix, "--profile", "example", "launch", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["host"] == "0.0.0.0"
    assert not list((tmp_path / "example/.pdum/runtime/runs").iterdir())


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
    assert "Select --default, --profile" in result.output


def test_default_native_import_then_configure_and_change_auth(tmp_path, monkeypatch):
    source = tmp_path / "native"
    source.mkdir()
    (source / "config.toml").write_text(
        'future="keep"\n[mcp_servers.one]\ncommand="one"\n[mcp_servers.two]\ncommand="two"\n'
    )
    monkeypatch.setenv("CODEX_HOME", str(source))
    monkeypatch.setenv("HOME", str(tmp_path))
    destination = tmp_path / "destination"
    runner = CliRunner()
    app = create_app()
    prefix = ["--profile-dir", str(destination)]
    result = runner.invoke(
        app,
        [
            *prefix,
            "profile",
            "create",
            "--no-interview",
            "--executable",
            sys.executable,
            "--mcp-server",
            "one",
            "--auth",
            "api-key",
            "--api-key-env",
            "EXAMPLE_KEY",
        ],
    )
    assert result.exit_code == 0, result.output
    config_path = destination / "config.toml"
    native = tomllib.loads(config_path.read_text())
    assert set(native["mcp_servers"]) == {"one"}
    assert native["future"] == "keep"
    original = (source / "config.toml").read_text()
    result = runner.invoke(app, [*prefix, "profile", "configure", "--no-interview", "--model", "gpt-6-luna"])
    assert result.exit_code == 0, result.output
    assert tomllib.loads(config_path.read_text())["model"] == "gpt-6-luna"
    result = runner.invoke(app, [*prefix, "auth", "configure", "--no-interview", "--method", "chatgpt"])
    assert result.exit_code == 0, result.output
    metadata = tomllib.loads((destination / ".pdum/launcher.toml").read_text())
    assert "EXAMPLE_KEY" not in metadata["environment"]["inherit_keys"]
    result = runner.invoke(app, [*prefix, "auth", "status"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["method"] == "chatgpt"
    assert json.loads(result.stdout)["authenticated"] == "not checked"
    assert (source / "config.toml").read_text() == original


def test_login_flag_runs_after_save_and_reports_failure(tmp_path, monkeypatch):
    from pdum.codex_launcher import cli

    called = []

    async def explicit_login(directory, *, device_auth=False):
        assert (directory / ".pdum/launcher.toml").is_file()
        assert (directory / "config.toml").is_file()
        called.append(device_auth)
        return 7

    monkeypatch.setattr(cli, "login_auth", explicit_login)
    result = CliRunner().invoke(
        create_app(),
        [
            "--profile-dir",
            str(tmp_path / "profile"),
            "profile",
            "create",
            "--clean",
            "--no-interview",
            "--executable",
            sys.executable,
            "--auth",
            "chatgpt",
            "--login",
            "--device-auth",
        ],
    )
    assert result.exit_code == 7, result.output
    assert called == [True]
    assert "Profile saved, but login did not complete" in result.output


def test_noninteractive_federation_settings_and_inventory(tmp_path):
    settings = tmp_path / "aws.toml"
    settings.write_text('region="us-east-1"\nidentity_provider_id="idp-example"\nservice_account_id="sa-example"\n')
    destination = tmp_path / "profile"
    runner = CliRunner()
    app = create_app()
    result = runner.invoke(
        app,
        [
            "--profile-dir",
            str(destination),
            "profile",
            "create",
            "--clean",
            "--no-interview",
            "--executable",
            sys.executable,
            "--auth",
            "aws-federation",
            "--federation-settings",
            str(settings),
        ],
    )
    assert result.exit_code == 0, result.output
    native = tomllib.loads((destination / "config.toml").read_text())
    assert native["model_providers"][native["model_provider"]]["supports_websockets"]
    result = runner.invoke(app, ["profile", "inventory", "--source", str(destination)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"marketplaces": [], "plugins": [], "mcp_servers": [], "skills": []}


def test_invalid_flags_do_not_create_profile(tmp_path):
    runner = CliRunner()
    destination = tmp_path / "profile"
    prefix = ["--profile-dir", str(destination), "profile", "create", "--no-interview", "--executable", sys.executable]
    for flags in (
        ["--clean", "--copy-auth"],
        ["--from-codex-home", str(tmp_path), "--from-profile-dir", str(tmp_path)],
        ["--clean", "--auth", "aws-federation"],
        ["--clean", "--auth", "invalid"],
    ):
        result = runner.invoke(create_app(), [*prefix, *flags])
        assert result.exit_code == 1, result.output
        assert not destination.exists()


def test_default_selects_the_users_codex_home_and_launch_passes_overrides(tmp_path, monkeypatch):
    home = tmp_path / "daily-home"
    home.mkdir()
    (home / "config.toml").write_text('model = "daily"\n')
    monkeypatch.setenv("CODEX_HOME", str(home))
    runner = CliRunner()
    app = create_app()
    result = runner.invoke(app, ["--default", "profile", "create", "--no-interview"])
    assert result.exit_code == 1
    assert "cannot be created" in result.output
    result = runner.invoke(app, ["--default", "--profile", "other", "status"])
    assert result.exit_code != 0
    result = runner.invoke(
        app,
        [
            "--default",
            "launch",
            "--dry-run",
            "--executable",
            sys.executable,
            "--model",
            "gpt-6-luna",
            "-c",
            'sandbox_mode="danger-full-access"',
            "-c",
            "features.plugins=true",
        ],
    )
    assert result.exit_code == 0, result.output
    plan = json.loads(result.stdout)
    assert plan["profile"] == str(home.resolve())
    assert plan["managed"] is False
    assert plan["isolate"] is False
    assert plan["environment_mode"] == "inherit"
    assert plan["arguments"][3:] == [
        "-c",
        'model="gpt-6-luna"',
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        "features.plugins=true",
    ]
    assert (home / "config.toml").read_text() == 'model = "daily"\n'
    result = runner.invoke(app, ["--default", "launch", "--dry-run", "--executable", sys.executable, "-c", "broken"])
    assert result.exit_code == 1
    assert "key=value" in result.output
    result = runner.invoke(app, ["--default", "--json", "status"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"profile": str(home.resolve()), "runs": [], "live_runs": []}
    result = runner.invoke(app, ["--default", "--json", "inspect", "--no-probe"])
    assert result.exit_code == 0, result.output
    report = json.loads(result.stdout)
    assert report["home"] == str(home.resolve())
    assert report["managed"] is False
    result = runner.invoke(app, ["--default", "inspect", "--no-probe"])
    assert result.exit_code == 0, result.output
    assert "Processes touching this home" in result.output


def test_managed_profile_launch_dry_run_isolates_and_no_isolate_overrides(tmp_path):
    runner = CliRunner()
    app = create_app()
    prefix = ["--profile-dir", str(tmp_path / "profile")]
    result = runner.invoke(
        app, [*prefix, "profile", "create", "--clean", "--no-interview", "--executable", sys.executable]
    )
    assert result.exit_code == 0, result.output
    result = runner.invoke(app, [*prefix, "launch", "--dry-run"])
    assert result.exit_code == 0, result.output
    plan = json.loads(result.stdout)
    assert plan["isolate"] is True
    assert plan["cwd"] == str((tmp_path / "profile").resolve() / ".pdum/work")
    assert plan["arguments"] == ["app-server", "--listen", "unix://<private socket>"]
    result = runner.invoke(app, [*prefix, "launch", "--dry-run", "--no-isolate", "--inherit-environment"])
    assert result.exit_code == 0, result.output
    plan = json.loads(result.stdout)
    assert plan["isolate"] is False
    assert plan["environment_mode"] == "inherit"
