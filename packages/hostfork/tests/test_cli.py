"""Real CLI parsing and local state operations, including mounting as a sub-app."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
import typer
from pdum.hostfork.cli import create_app
from typer.testing import CliRunner

runner = CliRunner()


def invoke(root: Path, *arguments: str):
    return runner.invoke(create_app(), ["--root", str(root), "--json", *arguments])


def test_import_and_app_factory_do_not_launch_or_install_handlers() -> None:
    script = """
import json, signal, sys
def audit(event, args):
    if event in ('subprocess.Popen', 'os.fork', 'os.posix_spawn'):
        raise AssertionError('Unexpected process launch: ' + event)
sys.addaudithook(audit)
handlers = {value: signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)}
from pdum.hostfork.cli import create_app
import typer
parent = typer.Typer()
parent.add_typer(create_app(), name='fork')
assert handlers == {value: signal.getsignal(value) for value in handlers}
print(json.dumps({'mounted': True}))
"""
    result = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True, timeout=10)
    assert json.loads(result.stdout) == {"mounted": True}


def test_mounted_help_and_empty_inventory_do_not_initialize_state(tmp_path: Path) -> None:
    root = tmp_path / "missing"
    parent = typer.Typer()
    parent.add_typer(create_app(), name="fork")
    help_result = runner.invoke(parent, ["fork", "--help"])
    assert help_result.exit_code == 0, help_result.output
    assert "doctor" in help_result.output and "support" in help_result.output and "shell" in help_result.output
    result = runner.invoke(parent, ["fork", "--root", str(root), "--json", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == []
    assert not root.exists()


@pytest.mark.parametrize("command", ["list", "usage", "reap", "gc"])
def test_empty_root_operations_are_readable_without_a_runtime(tmp_path: Path, command: str) -> None:
    root = tmp_path / "store"
    result = invoke(root, command)
    assert result.exit_code == 0, result.output
    assert isinstance(json.loads(result.stdout), (list, dict))
    assert not root.exists()


@pytest.mark.parametrize("extension", ["json", "toml"])
def test_spec_plan_accepts_public_schema_without_allocation(tmp_path: Path, extension: str) -> None:
    root, source, pool = tmp_path / "store", tmp_path / "source", tmp_path / "pool"
    source.mkdir()
    (source / "original").write_text("host")
    spec_path = tmp_path / ("spec." + extension)
    request = {
        "trees": {"project": {"source": str(source), "storage": "copy", "pool": "scratch"}},
        "view": {"kind": "workspace", "tree": "project"},
        "lifetime": {"max_runtime": 5},
        "limits": {"memory_bytes": 67108864, "cpu_cores": 0.5},
    }
    if extension == "json":
        spec_path.write_text(json.dumps(request))
    else:
        spec_path.write_text(
            "[trees.project]\n" + f"source = {json.dumps(str(source))}\n"
            'storage = "copy"\npool = "scratch"\n'
            '[view]\nkind = "workspace"\ntree = "project"\n'
            "[lifetime]\nmax_runtime = 5\n[limits]\nmemory_bytes = 67108864\ncpu_cores = 0.5\n"
        )
    result = invoke(root, "--pool", f"scratch={pool}", "plan", "--spec", str(spec_path))
    assert result.exit_code == (0 if sys.platform == "linux" else 1), result.output
    planned = json.loads(result.stdout)
    assert planned["spec"]["view"] == request["view"]
    assert planned["spec"]["limits"] == request["limits"]
    assert planned["storage_roots"]["scratch"] == str(pool)
    assert not root.exists() and not pool.exists()
    assert (source / "original").read_text() == "host"


@pytest.mark.skipif(sys.platform != "linux", reason="Baseline validation uses the implemented Linux storage backend")
def test_baseline_registration_and_listing_use_selected_root(tmp_path: Path) -> None:
    root, source = tmp_path / "store", tmp_path / "source"
    source.mkdir()
    result = invoke(root, "baseline", "register", "input", str(source))
    assert result.exit_code == 0, result.output
    baseline = json.loads(result.stdout)
    assert baseline["path"] == str(source)
    result = invoke(root, "baseline", "list")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"input": baseline}
    assert (root / "registry.sqlite").exists()
    assert list(source.iterdir()) == []


def test_doctor_and_support_commands_with_isolated_unit_directory(tmp_path: Path) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    diagnosis = invoke(root, "doctor")
    assert diagnosis.exit_code == 0, diagnosis.output
    assert json.loads(diagnosis.stdout)["probe_requested"] is False
    assert not root.exists()
    plan = invoke(root, "support", "plan", "--unit-dir", str(units))
    assert plan.exit_code == 0, plan.output
    assert json.loads(plan.stdout)["manage_manager"] is False
    assert not units.exists()
    for action in ("install", "status", "install"):
        result = invoke(root, "support", action, "--unit-dir", str(units))
        assert result.exit_code == 0, result.output
        assert json.loads(result.stdout)["installed"] is True
    removed = invoke(root, "support", "uninstall", "--unit-dir", str(units))
    assert removed.exit_code == 0, removed.output
    assert len(json.loads(removed.stdout)["removed_files"]) == 3
    assert list(units.iterdir()) == []


def test_invalid_pool_and_detach_without_deadline_fail_before_allocation(tmp_path: Path) -> None:
    root = tmp_path / "store"
    malformed_pool = invoke(root, "--pool", "relative=path", "list")
    assert malformed_pool.exit_code == 2
    request = tmp_path / "spec.json"
    request.write_text("{}")
    detached = invoke(root, "create", "--spec", str(request))
    assert detached.exit_code == 1
    assert "deadline" in detached.output
    assert not root.exists()


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ('{"view":{"kind":"imaginary"}}', "Unknown view"),
        ('{"unexpected_key":true}', "unexpected keyword argument"),
        ("not json", "Expecting value"),
    ],
)
def test_invalid_spec_reports_error_without_traceback(tmp_path: Path, content: str, message: str) -> None:
    root, spec = tmp_path / "store", tmp_path / "invalid.json"
    spec.write_text(content)
    result = invoke(root, "plan", "--spec", str(spec))
    assert result.exit_code == 1
    assert "Error:" in result.output and message in result.output
    assert "Traceback" not in result.output
    assert not root.exists()


def test_invalid_convenience_options_fail_before_launch(tmp_path: Path) -> None:
    root = tmp_path / "store"
    result = invoke(root, "run", "--copy", "/missing-target", "--", "/bin/true")
    assert result.exit_code == 1 and "SOURCE=TARGET" in result.output
    assert not root.exists()
