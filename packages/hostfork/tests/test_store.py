"""Durable reservations and wrong-path cleanup rejection."""

import asyncio
import json

import pytest
from pdum.hostfork.errors import OwnershipConflict
from pdum.hostfork.store import Store, identifier


def test_reads_do_not_initialize(tmp_path):
    store = Store(tmp_path / "state")
    assert store.environments() == []
    assert not store.root.exists()
    with pytest.raises(FileNotFoundError):
        _ = store.id
    with pytest.raises(ValueError):
        identifier("../outside")


def test_registry_transactions_and_markers(tmp_path):
    store = Store(tmp_path / "state")
    record = store.create_environment({"spec": {}})
    assert store.verify_run(record["id"]).exists()
    original_id = store.id
    store.initialize()
    assert store.id == original_id
    store.event(record["id"], "sample", {"value": 1})
    assert store.events(record["id"])[0]["record"] == {"value": 1}
    with pytest.raises(RuntimeError), store.transaction() as transaction:
        transaction.execute("DELETE FROM environments")
        raise RuntimeError("rollback")
    assert store.environment(record["id"])["state"] == "creating"
    marker = store.run_path(record["id"]) / ".hostfork-owner.json"
    marker.write_text("{}")
    with pytest.raises(OwnershipConflict):
        store.verify_run(record["id"])


def test_dependency_reservation_and_path_replacement(tmp_path):
    store = Store(tmp_path / "state")
    record = store.create_environment({})
    store.register_baseline("base", {"path": "/base"})
    resource = store.reserve_resource(record["id"], pool=tmp_path / "pool", name="data", kind="copy", baseline="base")
    with pytest.raises(OwnershipConflict):
        store.register_baseline("base", {"path": "/new"})
    resource = store.prepare_allocation(resource)
    allocation = store.verify_allocation(resource)
    allocation.rename(allocation.with_name("old"))
    allocation.mkdir()
    (allocation / ".hostfork-owner.json").write_text(
        json.dumps({"registry": store.id, "environment": record["id"], "allocation": resource["id"]})
    )
    with pytest.raises(OwnershipConflict, match="identity"):
        store.verify_allocation(resource)
    store.update_resource(resource["id"], state="released")
    store.register_baseline("base", {"path": "/new"})


@pytest.mark.asyncio
async def test_operation_lock_contention_and_cancellation(tmp_path):
    store = Store(tmp_path / "state")
    record = store.create_environment({})
    async with store.lock(record["id"]):
        with pytest.raises(TimeoutError):
            async with store.lock(record["id"], timeout=0.01):
                pytest.fail("lock admitted twice")
        task = asyncio.create_task(store.lock(record["id"]).__aenter__())
        await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with store.lock(record["id"], timeout=0):
        pass
