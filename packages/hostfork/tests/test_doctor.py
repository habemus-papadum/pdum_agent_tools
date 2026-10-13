"""Capability observations and disposable probes against the actual host."""

import importlib
import json
import os
import sys
from pathlib import Path

import pytest

diagnostics = importlib.import_module("pdum.hostfork.doctor")


async def test_inspection_does_not_create_requested_root(tmp_path: Path) -> None:
    root = tmp_path / "missing" / "store"
    result = await diagnostics.doctor(root)
    assert not root.parent.exists()
    assert result["probe_requested"] is False
    storage = result["capabilities"]["storage"]
    assert storage["existing_parent"] == str(tmp_path)
    assert storage["path_exists"] is False
    assert storage["snapshot_creation"] == "untested"
    assert storage["reclamation"] == "untested"
    json.dumps(result)


async def test_non_linux_reports_unsupported_backend(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diagnostics.sys, "platform", "darwin")
    result = await diagnostics.doctor(tmp_path, probe=True)
    for name in ("namespace", "systemd", "cgroup"):
        assert result["capabilities"][name]["evidence"] == "unsupported"
        assert result["capabilities"][name]["available"] is False
    assert list(tmp_path.iterdir()) == []


async def test_missing_command_and_timeout_are_observations(tmp_path: Path) -> None:
    result = await diagnostics._run([str(tmp_path / "absent-command")])
    assert result["returncode"] is None
    assert "error" in result
    result = await diagnostics._run([sys.executable, "-c", "import time; time.sleep(20)"], timeout=0.05)
    assert result["returncode"] is None
    assert "exceeded" in result["error"]


async def test_doctor_reports_moved_support_interpreter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    if sys.platform != "linux":
        pytest.skip("Support diagnosis belongs to the implemented Linux backend")
    from pdum.hostfork import support

    configuration = tmp_path / "config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(configuration))
    root = tmp_path / "store"
    await support.install(
        root, unit_dir=configuration / "systemd" / "user", python_executable=tmp_path / "moved-python"
    )
    result = await diagnostics.doctor(root)
    integration = result["capabilities"]["support"]
    assert integration["installed_interpreter_exists"] is False
    assert any(finding["capability"] == "support" for finding in result["findings"])
    assert not root.exists()


@pytest.mark.hostfork_linux
async def test_disposable_host_probes(tmp_path: Path) -> None:
    result = await diagnostics.doctor(tmp_path, probe=True)
    capabilities = result["capabilities"]
    namespace = capabilities["namespace"]
    required = (
        namespace.get("user_mount") is True,
        namespace.get("overlay") is True,
        namespace.get("read_only_bind") is True,
        namespace.get("recursive_read_only") is True,
        capabilities["systemd"].get("pidfd_registration") == "observed",
        capabilities["cgroup"].get("delegated_scope") == "observed",
    )
    if not all(required):
        reason = json.dumps(result, sort_keys=True)
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    assert namespace["evidence"] == "observed"
    assert capabilities["cgroup"]["probe"]["subgroup_removed"] is True
    assert capabilities["cgroup"]["probe"]["empty_subgroup_kill"] is True
    assert not Path(capabilities["cgroup"]["probe"]["path"]).exists()
    assert capabilities["cgroup"]["aggregate_limits"] == "untested"
    assert capabilities["systemd"]["runtime_timer"] == "configuration_accepted"
    assert list(tmp_path.iterdir()) == []
