"""Fault injection for durable storage ownership; no simulated OS success claims."""

import asyncio
import shutil
import sys
import time
from pathlib import Path

import pytest
from pdum.hostfork import EnvironmentSpec, Hostfork, Retention, storage
from pdum.hostfork.environment import owner_identity
from pdum.hostfork.errors import EnvironmentClosed, OwnershipConflict
from pdum.hostfork.storage import _trees

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Real Linux storage and ownership recovery")


async def allocated_run(tmp_path, *, retention=None, kind="copy"):
    host = Hostfork(tmp_path / "state")
    spec = EnvironmentSpec(retention=retention or Retention())
    plan = await host.plan(spec)
    record = host.store.create_environment(plan.to_dict())
    source = None
    if kind == "overlay":
        source = tmp_path / "stable-source"
        source.mkdir()
    resource = host.store.reserve_resource(
        record["id"],
        pool=tmp_path / "pool",
        name="work",
        kind=kind,
        source=str(source) if source else None,
        stable=True,
    )
    resource = host.store.prepare_allocation(resource)
    tree = await storage.allocate(kind, Path(resource["allocation_path"]), source)
    resource = host.store.update_resource(resource["id"], state="ready", tree=tree)
    return host, record, resource


@pytest.mark.asyncio
async def test_failed_setup_reaps_then_retention_separates_evidence(tmp_path):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    host.store.update_environment(record["id"], state="setup_failed")
    result = await Hostfork(host.store.root).reap(record["id"])
    assert result[0]["state"] == "stopped"
    assert result[0]["gc"]["released"] == [resource["id"]]
    assert host.store.run_path(record["id"]).exists()
    assert (await host.usage())["retained_trees"] == 0


@pytest.mark.asyncio
async def test_live_allocator_and_uncertain_export_block_deletion(tmp_path):
    host, record, resource = await allocated_run(tmp_path)
    host.store.update_environment(
        record["id"], state="stopped", stopped_at=time.time(), operation_owner=owner_identity()
    )
    assert "live allocator" in (await host.gc(record["id"], force=True))[0]["pending"]
    host.store.update_environment(record["id"], operation_owner=None, exports=[{"state": "failed", "owner": None}])
    assert "incomplete export" in (await host.gc(record["id"], force=True))[0]["pending"][0]
    assert Path(resource["tree"]["path"]).exists()
    assert (await host.gc(record["id"], force=True, discard_incomplete=True))[0]["state"] == "purged"


@pytest.mark.asyncio
async def test_wrong_path_is_pending_not_deleted(tmp_path):
    host, record, resource = await allocated_run(tmp_path)
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    allocation = Path(resource["allocation_path"])
    allocation.rename(allocation.with_name("saved"))
    allocation.mkdir()
    (allocation / "precious").write_text("leave me")
    result = await host.gc(record["id"], force=True)
    assert result[0]["pending"]
    assert (allocation / "precious").read_text() == "leave me"
    assert host.store.run_path(record["id"]).exists()


@pytest.mark.asyncio
async def test_recover_after_storage_delete_and_evidence_delete_crashes(tmp_path):
    host, record, resource = await allocated_run(tmp_path)
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    host.store.update_resource(resource["id"], state="deleting")
    await storage.release(resource["tree"])
    assert (await host.gc(record["id"], force=True))[0]["state"] == "purged"
    other = host.store.create_environment(record["plan"])
    host.store.update_environment(other["id"], state="stopped", stopped_at=time.time(), evidence_purge_intent=True)
    shutil.rmtree(host.store.run_path(other["id"]))
    result = await host.reap(other["id"])
    assert result[0]["state"] == "purged"


@pytest.mark.asyncio
async def test_two_reapers_and_partial_allocation(tmp_path):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(0, 0))
    host.store.update_resource(resource["id"], state="allocating", tree=None)
    host.store.update_environment(record["id"], state="setup_failed")
    await asyncio.gather(host.reap(), Hostfork(host.store.root).reap())
    assert host.store.environment(record["id"])["state"] == "purged"
    assert not Path(resource["tree"]["path"]).exists()


@pytest.mark.asyncio
async def test_atomic_stop_prevents_setup_publication(tmp_path):
    host, record, _ = await allocated_run(tmp_path)
    host.store.update_environment(record["id"], stop_requested_at=time.time())
    with pytest.raises(EnvironmentClosed):
        host.store.update_environment(record["id"], state="running")


@pytest.mark.asyncio
async def test_baseline_replacement_between_plan_and_reservation(tmp_path):
    host, record, _ = await allocated_run(tmp_path)
    host.store.register_baseline("base", {"path": "/original"})
    before = host.store.baseline("base")
    host.store.register_baseline("base", {"path": "/replacement"})
    with pytest.raises(OwnershipConflict, match="changed"):
        host.store.reserve_resource(
            record["id"], pool=tmp_path / "pool", name="work2", kind="copy", baseline="base", expected_baseline=before
        )


async def test_dead_exporter_completed_publication_reconciles_before_gc(tmp_path):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    destination = tmp_path / "export"
    host.store.update_environment(
        record["id"],
        state="stopped",
        stopped_at=time.time(),
        exports=[{"tree": "work", "destination": str(destination), "state": "exporting", "owner": None}],
    )
    (Path(resource["tree"]["path"]) / "data").write_text("forensics")
    assert (await storage.export_tree(resource["tree"], destination))["state"] == "complete"
    # The OS export finished, but the caller died before persisting its result.
    result = await Hostfork(host.store.root).reap(record["id"])
    assert result[0]["gc"]["released"] == [resource["id"]]
    assert host.store.environment(record["id"])["exports"][0]["state"] == "complete"
    assert (destination / "data").read_text() == "forensics"


async def test_dead_partial_export_and_unrelated_destination_hold_gc(tmp_path, monkeypatch):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    destination = tmp_path / "export"
    host.store.update_environment(
        record["id"],
        state="stopped",
        stopped_at=time.time(),
        exports=[{"tree": "work", "destination": str(destination), "state": "exporting", "owner": None}],
    )
    original = _trees._run

    def fail_copy(*args, **kwargs):
        if args[0] == "cp":
            (Path(args[-1]) / "partial-data").write_text("partial forensics")
            raise OSError("injected copy failure")
        return original(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(_trees, "_run", fail_copy)
        assert (await storage.export_tree(resource["tree"], destination))["state"] == "failed"
    result = await host.reap(record["id"])
    assert "incomplete export" in result[0]["gc"]["pending"][0]
    exported = host.store.environment(record["id"])["exports"][0]
    assert exported["state"] == "partial"
    assert (Path(exported["partial_path"]) / "tree" / "partial-data").read_text() == "partial forensics"
    assert Path(resource["tree"]["path"]).is_dir()
    destination.mkdir()
    (destination / "precious").write_text("unrelated")
    await host.reap(record["id"])
    assert host.store.environment(record["id"])["exports"][0]["state"] == "conflict"
    assert (destination / "precious").read_text() == "unrelated"


async def test_purge_retries_after_marker_deleted_then_second_crash(tmp_path, monkeypatch):
    from pdum.hostfork import recovery

    host, record, _ = await allocated_run(tmp_path)
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    run = host.store.run_path(record["id"])
    (run / "remaining-evidence").write_text("partial removal")
    original = recovery.shutil.rmtree

    def interrupted(path, *args, **kwargs):
        if Path(path) == run:
            (run / ".hostfork-owner.json").unlink(missing_ok=True)
            raise OSError("injected evidence deletion interruption")
        return original(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(recovery.shutil, "rmtree", interrupted)
        assert (await host.gc(record["id"], force=True))[0]["pending"]
        assert host.store.environment(record["id"])["evidence_purge_intent"]["identity"]
        assert (await Hostfork(host.store.root).reap(record["id"]))[0]["state"] == "recovery_pending"
        assert run.exists()
    assert (await Hostfork(host.store.root).reap(record["id"]))[0]["state"] == "purged"
    assert not run.exists()


async def test_purge_intent_refuses_replacement_directory(tmp_path):
    from pdum.hostfork.store import path_identity

    host, record, resource = await allocated_run(tmp_path)
    await storage.release(resource["tree"])
    host.store.update_resource(resource["id"], state="released")
    run = host.store.run_path(record["id"])
    host.store.update_environment(
        record["id"],
        state="stopped",
        stopped_at=time.time(),
        evidence_purge_intent={"path": str(run), "identity": path_identity(run)},
    )
    run.rename(run.with_name("original-run"))
    run.mkdir()
    (run / "precious").write_text("unrelated")
    result = await host.reap(record["id"])
    assert result[0]["state"] == "recovery_pending"
    assert "identity changed" in result[0]["error"]
    assert (run / "precious").read_text() == "unrelated"


async def test_reclamation_is_opt_in_and_failed_measurement_stays_pending(tmp_path, monkeypatch):
    from pdum.hostfork import recovery

    host, record, resource = await allocated_run(tmp_path)
    await storage.release(resource["tree"])
    host.store.update_resource(resource["id"], state="released", release={"reclamation": "pending"})
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    attempts = []

    async def unavailable(value, *, timeout):
        attempts.append(timeout)
        raise PermissionError("injected missing filesystem sync privilege")

    monkeypatch.setattr(storage, "confirm_reclamation", unavailable)
    await recovery.gc(host, record["id"])
    assert attempts == []
    await recovery.gc(host, record["id"], reclamation_timeout=0.5)
    assert 0 < attempts[0] <= 0.5
    release = host.store.resources(record["id"])[0]["release"]
    assert release["reclamation"] == "pending"
    assert release["reclamation_observation"]["state"] == "unavailable"


@pytest.mark.parametrize("kind", ["copy", "overlay"])
async def test_gc_removes_only_released_owned_allocation_directory(tmp_path, kind):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0), kind=kind)
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    allocation = Path(resource["allocation_path"])
    assert (await host.gc(record["id"]))[0]["pending"] == []
    assert not allocation.exists()
    released = host.store.resources(record["id"])[0]
    assert released["directory_removed"] is True
    assert released["release"]["allocation_directory_retained"] is False
    assert (await host.gc(record["id"]))[0]["pending"] == []
    if kind == "overlay":
        assert Path(resource["source"]).is_dir()


async def test_allocation_directory_retry_after_marker_removal_preserves_unexpected_files(tmp_path):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    allocation = Path(resource["allocation_path"])
    unexpected = allocation / "unexpected"
    unexpected.write_text("preserve")
    result = await host.gc(record["id"])
    assert "allocation directory" in result[0]["pending"][0]
    assert not (allocation / ".hostfork-owner.json").exists()
    assert unexpected.read_text() == "preserve"
    resource = host.store.resources(record["id"])[0]
    assert resource["directory_purge_intent"]["identity"]
    assert not resource.get("directory_removed")
    assert (await host.usage())["pending_cleanup"] == 1
    unexpected.unlink()
    assert (await Hostfork(host.store.root).gc(record["id"]))[0]["pending"] == []
    assert not allocation.exists()
    assert host.store.resources(record["id"])[0]["directory_removed"] is True


async def test_allocation_purge_refuses_replaced_directory_after_marker_removal(tmp_path):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    allocation = Path(resource["allocation_path"])
    (allocation / "unexpected").write_text("old directory")
    assert (await host.gc(record["id"]))[0]["pending"]
    allocation.rename(allocation.with_name("original-allocation"))
    allocation.mkdir()
    (allocation / "precious").write_text("replacement")
    result = await Hostfork(host.store.root).gc(record["id"])
    assert "identity changed" in result[0]["pending"][0]
    assert (allocation / "precious").read_text() == "replacement"


async def test_allocation_purge_recovers_after_rmdir_before_observation(tmp_path, monkeypatch):
    host, record, resource = await allocated_run(tmp_path, retention=Retention(trees=0))
    host.store.update_environment(record["id"], state="stopped", stopped_at=time.time())
    original = host.store.update_resource

    def interrupted(identifier, **changes):
        if changes.get("directory_removed"):
            raise OSError("injected persistence failure after rmdir")
        return original(identifier, **changes)

    with monkeypatch.context() as patch:
        patch.setattr(host.store, "update_resource", interrupted)
        assert (await host.gc(record["id"]))[0]["pending"]
    assert not Path(resource["allocation_path"]).exists()
    assert not host.store.resources(record["id"])[0].get("directory_removed")
    assert (await Hostfork(host.store.root).gc(record["id"]))[0]["pending"] == []
    assert host.store.resources(record["id"])[0]["directory_removed"] is True
