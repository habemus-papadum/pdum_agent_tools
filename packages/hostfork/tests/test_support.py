"""Owned service integration without touching ordinary user unit directories."""

import json
import shutil
import sys
from pathlib import Path

import pytest
from pdum.hostfork import support


async def test_plan_install_idempotence_and_uninstall_preserve_data(tmp_path: Path) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    planned = await support.plan(root, unit_dir=units)
    assert not root.exists() and not units.exists()
    assert planned["manage_manager"] is False
    assert len(planned["files"]) == 3
    installed = await support.install(root, unit_dir=units)
    assert installed["installed"] is True
    assert len(installed["changed_files"]) == 3
    again = await support.install(root, unit_dir=units)
    assert again["changed_files"] == []
    assert (await support.status(root, unit_dir=units))["installed"] is True
    root.mkdir()
    (root / "evidence").write_text("retained")
    removed = await support.uninstall(root, unit_dir=units)
    assert len(removed["removed_files"]) == 3
    assert (root / "evidence").read_text() == "retained"
    assert list(units.iterdir()) == []
    assert (await support.uninstall(root, unit_dir=units))["removed_files"] == []


async def test_edited_and_unowned_units_are_never_replaced(tmp_path: Path) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    installed = await support.install(root, unit_dir=units)
    edited = Path(installed["files"][0]["path"])
    edited.write_text("operator edit\n")
    status = await support.status(root, unit_dir=units)
    assert status["conflicts"] and not status["installed"]
    with pytest.raises(support.SupportConflictError, match="edited"):
        await support.install(root, unit_dir=units)
    with pytest.raises(support.SupportConflictError, match="edited"):
        await support.uninstall(root, unit_dir=units, force=True)
    assert edited.read_text() == "operator edit\n"

    second_root = tmp_path / "second"
    second = await support.plan(second_root, unit_dir=units)
    unowned = Path(second["files"][0]["path"])
    unowned.write_text(second["files"][0]["content"])
    with pytest.raises(support.SupportConflictError, match="unowned"):
        await support.install(second_root, unit_dir=units)


async def test_missing_units_and_interpreter_upgrade(tmp_path: Path) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    installed = await support.install(root, unit_dir=units)
    Path(installed["files"][0]["path"]).unlink()
    assert not (await support.status(root, unit_dir=units))["installed"]
    repaired = await support.install(root, unit_dir=units)
    assert len(repaired["changed_files"]) == 1
    # Keep the operator's chosen venv path, even if it is a symlink to base Python.
    python = tmp_path / "venv-python"
    python.symlink_to(sys.executable)
    updated = await support.install(root, unit_dir=units, python_executable=python)
    assert len(updated["changed_files"]) == 2
    assert updated["python_executable"] == str(python)
    assert str(python) in Path(updated["files"][0]["path"]).read_text()


async def test_active_run_guard_and_distinct_store_names(tmp_path: Path) -> None:
    units = tmp_path / "units"
    a = await support.install(tmp_path / "a", unit_dir=units)
    b = await support.install(tmp_path / "b", unit_dir=units)
    assert a["prefix"] != b["prefix"]
    with pytest.raises(support.SupportConflictError, match="Active runs"):
        await support.uninstall(tmp_path / "a", unit_dir=units, active_runs=["environment-1"])
    removed = await support.uninstall(tmp_path / "a", unit_dir=units, active_runs=["environment-1"], force=True)
    assert removed["active_runs"] == ["environment-1"]
    assert (await support.status(tmp_path / "b", unit_dir=units))["installed"] is True


async def test_interrupted_install_can_resume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    original = support._atomic
    interrupted = False

    def fail_once(path: Path, content: str) -> None:
        nonlocal interrupted
        if path.name.endswith(".timer") and not interrupted:
            interrupted = True
            raise OSError("injected disk failure")
        original(path, content)

    monkeypatch.setattr(support, "_atomic", fail_once)
    with pytest.raises(OSError, match="injected"):
        await support.install(root, unit_dir=units)
    partial = await support.status(root, unit_dir=units)
    assert partial["installation_state"] == "incomplete"
    assert partial["conflicts"] == []
    assert (await support.install(root, unit_dir=units))["installed"] is True


@pytest.mark.parametrize("manifest_content", ["[]", '{"schema_version":99}', "not json"])
async def test_invalid_manifest_never_grants_ownership(tmp_path: Path, manifest_content: str) -> None:
    units = tmp_path / "units"
    planned = await support.plan(tmp_path / "store", unit_dir=units)
    units.mkdir()
    Path(planned["manifest"]).write_text(manifest_content)
    with pytest.raises(support.SupportConflictError, match="manifest"):
        await support.install(tmp_path / "store", unit_dir=units)


async def test_symlinks_and_line_breaks_are_reported(tmp_path: Path) -> None:
    root, units = tmp_path / "store", tmp_path / "units"
    installed = await support.install(root, unit_dir=units)
    path = Path(installed["files"][0]["path"])
    path.unlink()
    target = tmp_path / "unrelated"
    target.write_text("unchanged")
    path.symlink_to(target)
    with pytest.raises(support.SupportConflictError, match="symlink"):
        await support.uninstall(root, unit_dir=units, force=True)
    assert target.read_text() == "unchanged"
    with pytest.raises(ValueError, match="newlines"):
        await support.plan(tmp_path / "newline\npath", unit_dir=units)


async def test_systemd_accepts_generated_units_and_literal_path_escaping(tmp_path: Path) -> None:
    if sys.platform != "linux" or not shutil.which("systemd-analyze"):
        pytest.skip("Requires the real Linux systemd unit parser")
    from pdum.hostfork.doctor import _run

    root = tmp_path / 'store with % and $ and "quotes"'
    installed = await support.install(root, unit_dir=tmp_path / "units")
    paths = [entry["path"] for entry in installed["files"]]
    result = await _run(["systemd-analyze", "--user", "verify", *paths])
    assert result["returncode"] == 0, result
    content = Path(paths[0]).read_text()
    assert "ExecStart=:" in content
    assert "%%" in content
    assert "%i" in Path(paths[-1]).read_text()
    manifest = json.loads(Path(installed["manifest"]).read_text())
    assert manifest["generator_version"] == 1
