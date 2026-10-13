"""Prepared Btrfs storage through the public environment lifecycle."""

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from pdum.hostfork import EnvironmentSpec, Hostfork, HostView, Lifetime, PrivateTree
from pdum.hostfork.doctor import doctor
from pdum.hostfork.storage import _trees

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hostfork_btrfs,
    pytest.mark.hostfork_linux,
    pytest.mark.skipif(sys.platform != "linux", reason="Prepared Btrfs and Linux runtime integration"),
]


async def test_btrfs_public_environment_private_write_export_and_gc(tmp_path: Path) -> None:
    prepared = os.environ.get("PDUM_HOSTFORK_TEST_BTRFS_ROOT")
    if not prepared or not shutil.which("btrfs"):
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_BTRFS") == "1":
            pytest.fail("Required prepared Btrfs scratch root or btrfs tools unavailable")
        pytest.skip("Set PDUM_HOSTFORK_TEST_BTRFS_ROOT to a prepared Btrfs scratch root")
    capabilities = (await doctor(probe=True))["capabilities"]
    if not capabilities["namespace"]["available"] or not capabilities["systemd"]["available"]:
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
            pytest.fail(f"Required Linux runtime unavailable: {capabilities}")
        pytest.skip("Usable user namespaces and user systemd are required")

    with tempfile.TemporaryDirectory(prefix="hostfork-environment-test-", dir=prepared) as temporary:
        scratch = Path(temporary)
        baseline = scratch / "baseline"
        pool = scratch / "allocations"
        pool.mkdir()
        _trees._btrfs("subvolume", "create", baseline)
        host = Hostfork(tmp_path / "state", pools={"prepared": pool})
        environment = None
        try:
            (baseline / "data").write_text("baseline")
            _trees._btrfs("property", "set", "-ts", baseline, "ro", "true")
            await host.register_baseline("prepared", baseline, storage="btrfs")
            environment = await host.create(
                EnvironmentSpec(
                    trees={"work": PrivateTree(baseline="prepared", storage="btrfs", pool="prepared")},
                    view=HostView(replace={str(baseline): "work"}),
                    lifetime=Lifetime(max_runtime=20),
                )
            )
            command = await environment.spawn(
                ["/bin/sh", "-c", "printf private > data; printf created > added; cat data"],
                cwd=baseline,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await command.communicate()
            assert stdout == b"private" and stderr == b""
            assert (await command.wait()).returncode == 0
            await command.wait_tree()
            assert (baseline / "data").read_text() == "baseline"
            assert not (baseline / "added").exists()
            assert (await environment.stop())["state"] == "stopped"
            resource = host.store.resources(environment.id)[0]
            assert resource["kind"] == "btrfs"
            assert resource["tree"]["subvolume"]["subvolume_uuid"]
            assert Path(resource["tree"]["path"]).is_relative_to(pool)

            # A fresh controller must validate stored identities and export the
            # retained snapshot after the workload namespace has disappeared.
            reopened_host = Hostfork(host.store.root, pools={"prepared": pool})
            reopened = await reopened_host.open(environment.id)
            exported = await reopened.export("work", tmp_path / "export")
            assert exported["state"] == "complete", exported
            assert (tmp_path / "export" / "data").read_text() == "private"
            assert (tmp_path / "export" / "added").read_text() == "created"
            collected = await reopened_host.gc(environment.id, force=True)
            assert collected[0]["state"] == "purged" and not collected[0]["pending"], collected
            resource = host.store.resources(environment.id)[0]
            assert resource["state"] == "released"
            assert resource["release"]["reclamation"] == "pending"
            assert Path(resource["allocation_path"]).exists()
            assert not Path(resource["tree"]["path"]).exists()
            assert (await host.usage())["pending_reclamation"] == 1
            assert (baseline / "data").read_text() == "baseline"
            assert _trees._btrfs("property", "get", "-ts", baseline, "ro") == "ro=true"
        finally:
            if environment is not None:
                await environment.stop()
            await host.reap()
            await host.gc(force=True, discard_incomplete=True)
            # Only this test-owned borrowed baseline is removed by the fixture.
            _trees._btrfs("property", "set", "-ts", baseline, "ro", "false")
            _trees._btrfs("subvolume", "delete", baseline)
