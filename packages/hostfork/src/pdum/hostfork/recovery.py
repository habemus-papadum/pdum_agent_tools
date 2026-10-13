"""Independent reconciliation, retention and measured local inventory."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path
from typing import TYPE_CHECKING

from . import storage
from .environment import finish, owner_alive
from .models import seconds
from .store import path_identity

if TYPE_CHECKING:
    from .environment import Hostfork


def _records(hostfork: Hostfork, environment_id: str | None) -> list[dict]:
    return [hostfork.store.environment(environment_id)] if environment_id else hostfork.store.environments()


async def reap(hostfork: Hostfork, environment_id: str | None = None) -> list[dict]:
    """Reconcile independently of the original caller; uncertain ownership stays pending."""
    results = []
    for record in _records(hostfork, environment_id):
        if record["state"] == "purged":
            continue
        try:
            if record.get("evidence_purge_intent"):
                async with hostfork.store.lock(record["id"], timeout=0.1):
                    await _finish_purge(hostfork, hostfork.store.environment(record["id"]))
                results.append({"id": record["id"], "state": "purged"})
                continue
            environment = await hostfork.open(record["id"])
            runtime = await environment._runtime.inspect() if environment._runtime else None
            creating = owner_alive(record.get("operation_owner"))
            should_stop = record["state"] in ("setup_failed", "cleanup_pending", "stopping", "stopped")
            reason = record.get("stop_reason", "recovery")
            if runtime:
                expired = (
                    runtime.get("boot_id") == _boot_id()
                    and runtime.get("deadline_monotonic") is not None
                    and time.monotonic() >= runtime["deadline_monotonic"]
                )
                owner_lost = (
                    runtime.get("owner_exit") == "stop"
                    and not record.get("detached")
                    and not owner_alive(runtime.get("owner"))
                )
                # A live allocator journals runtime intent before publishing
                # the keeper identity. Absence during that interval is not loss.
                keeper_lost = not runtime.get("keeper_alive") and (runtime.get("state") == "running" or not creating)
                should_stop |= expired or owner_lost or keeper_lost
                reason = "deadline" if expired else "owner_lost" if owner_lost else reason
            elif not creating:
                should_stop = True
            if should_stop:
                # Never wait for allocator/export locks before terminating processes.
                record = await environment.stop(reason)
            results.append({"id": record["id"], "state": record["state"], "operation_pending": creating})
        except Exception as error:
            results.append({"id": record["id"], "state": "recovery_pending", "error": str(error)})
    collected = await gc(hostfork, environment_id)
    by_id = {item["id"]: item for item in collected}
    for result in results:
        result["gc"] = by_id.get(result["id"])
    return results


async def _finish_purge(hostfork: Hostfork, record: dict) -> None:
    """Finish one recorded purge while holding its environment operation lock."""
    store = hostfork.store
    if record["state"] == "purged":
        return
    if record["state"] != "stopped" or not record.get("stopped_at"):
        raise RuntimeError("Evidence purge lacks a confirmed stopped state")
    if owner_alive(record.get("operation_owner")) or any(
        owner_alive(item.get("owner")) for item in record.get("exports", [])
    ):
        raise RuntimeError("Evidence purge still has a live operation owner")
    if any(resource["state"] != "released" for resource in store.resources(record["id"])):
        raise RuntimeError("Evidence purge still has retained trees")
    run = store.run_path(record["id"])
    if os.path.lexists(run):
        intent = record.get("evidence_purge_intent")
        if not isinstance(intent, dict) or intent.get("path") != str(run):
            raise RuntimeError("Existing evidence directory has no recorded purge identity")
        if path_identity(run) != intent.get("identity"):
            raise RuntimeError("Evidence directory identity changed after purge intent")
        # The ownership marker may already have been deleted by an interrupted
        # rmtree. The durable intent binds deletion to the original directory.
        await finish(asyncio.to_thread(shutil.rmtree, run))
    store.update_environment(record["id"], state="purged", evidence_deleted_at=time.time())
    hostfork._environments.pop(record["id"], None)


async def _recover_exports(hostfork: Hostfork, record: dict) -> dict:
    exports = record.get("exports", [])
    resources = {resource["name"]: resource for resource in hostfork.store.resources(record["id"])}
    changed = False
    for exported in exports:
        if exported["state"] == "complete" or owner_alive(exported.get("owner")):
            continue
        if not exported.get("tree") or not exported.get("destination"):
            continue  # An incomplete legacy/injected record still holds GC.
        changed = True
        try:
            resource = resources[exported["tree"]]
            hostfork.store.verify_allocation(resource)
            value = resource.get("tree") or await storage.recover_record(
                resource["kind"],
                Path(resource["allocation_path"]),
                Path(resource["source"]) if resource["source"] else None,
                stable=resource["stable"],
            )
            await storage.inspect(value)
            observation = await storage.recover_export(value, Path(exported["destination"]))
        except (KeyError, OSError, RuntimeError, ValueError) as error:
            observation = {"state": "conflict", "error": str(error)}
        if observation["state"] == "complete" and exported.get("error"):
            exported["previous_error"] = exported.pop("error")
        exported.update(observation, owner=None, recovered_at=time.time())
    if changed:
        return hostfork.store.update_environment(record["id"], exports=exports)
    return record


async def _remove_allocation_directory(hostfork: Hostfork, resource: dict) -> None:
    """Retire only the marker and empty directory after owned trees are gone."""
    if resource.get("directory_removed") or resource["state"] != "released":
        return
    if resource["kind"] == "btrfs" and resource.get("release", {}).get("reclamation") != "confirmed":
        return  # Keep the filesystem anchor for optional reclamation confirmation.
    store = hostfork.store
    allocation = Path(resource["allocation_path"])
    release = {**resource.get("release", {}), "allocation_directory_retained": False}
    if not os.path.lexists(allocation):
        store.update_resource(
            resource["id"], directory_removed=True, directory_removal="observed-absent", release=release
        )
        return
    intent = resource.get("directory_purge_intent")
    if intent is None:
        store.verify_allocation(resource)
        intent = {"path": str(allocation), "identity": path_identity(allocation)}
        resource = store.update_resource(resource["id"], directory_purge_intent=intent)
    if intent.get("path") != str(allocation) or path_identity(allocation) != intent.get("identity"):
        raise RuntimeError(f"Allocation directory identity changed after purge intent: {allocation}")

    def remove() -> None:
        if path_identity(allocation) != intent["identity"]:
            raise RuntimeError(f"Allocation directory identity changed before removal: {allocation}")
        marker = allocation / ".hostfork-owner.json"
        if os.path.lexists(marker):
            if marker.is_symlink():
                raise RuntimeError(f"Allocation marker was replaced by a symlink: {marker}")
            store.verify_allocation(resource)
            marker.unlink()
        # No recursive removal: unexpected files keep this allocation pending.
        allocation.rmdir()

    await finish(asyncio.to_thread(remove))
    store.update_resource(resource["id"], directory_removed=True, directory_removal="removed", release=release)


async def _remove_released_directories(hostfork: Hostfork, environment_id: str, pending: list[str]) -> None:
    for resource in hostfork.store.resources(environment_id):
        try:
            await _remove_allocation_directory(hostfork, resource)
        except (OSError, RuntimeError, ValueError) as error:
            pending.append(f"allocation directory {resource['id']}: {error}")


async def _reconcile_reclamation(hostfork: Hostfork, environment_id: str | None, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    for resource in hostfork.store.resources(environment_id):
        release = resource.get("release", {})
        if resource["state"] != "released" or release.get("reclamation") != "pending":
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            confirmation = await storage.confirm_reclamation(resource["tree"], timeout=remaining)
        except (KeyError, OSError, RuntimeError, ValueError) as error:
            confirmation = {"state": "unavailable", "error": str(error)}
        if confirmation["state"] == "confirmed":
            release["reclamation"] = "confirmed"
        release["reclamation_observation"] = {**confirmation, "measured_at": time.time()}
        hostfork.store.update_resource(resource["id"], release=release)


def _boot_id() -> str | None:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return None


def _due(duration: float | None, stopped_at: float, force: bool) -> bool:
    duration = seconds(duration)
    return force or duration is not None and time.time() >= stopped_at + duration


async def gc(
    hostfork: Hostfork,
    environment_id: str | None = None,
    *,
    force: bool = False,
    discard_incomplete: bool = False,
    reclamation_timeout: float | None = None,
) -> list[dict]:
    """Delete eligible owned trees/evidence after a confirmed stop and operation fencing.

    ``reclamation_timeout`` opts into bounded Btrfs confirmation, as a total
    budget across pending resources. Ordinary GC/reaping never waits for it.
    """
    if reclamation_timeout is not None and reclamation_timeout <= 0:
        raise ValueError("Reclamation confirmation budget must be positive")
    store = hostfork.store
    results = []
    for record in _records(hostfork, environment_id):
        result = {"id": record["id"], "state": record["state"], "released": [], "pending": []}
        results.append(result)
        if record["state"] not in {"stopped", "purged"} or not record.get("stopped_at"):
            continue
        try:
            async with store.lock(record["id"], timeout=0.1):
                record = store.environment(record["id"])
                if record["state"] == "purged":
                    await _remove_released_directories(hostfork, record["id"], result["pending"])
                    continue
                if record["state"] != "stopped":
                    continue
                if record.get("evidence_purge_intent"):
                    await _finish_purge(hostfork, record)
                    result["state"] = "purged"
                    continue
                if owner_alive(record.get("operation_owner")):
                    result["pending"].append("live allocator")
                    continue
                exports = record.get("exports", [])
                if any(owner_alive(export.get("owner")) for export in exports):
                    result["pending"].append("live exporter")
                    continue
                record = await _recover_exports(hostfork, record)
                incomplete = any(export["state"] != "complete" for export in record.get("exports", []))
                if incomplete and not discard_incomplete:
                    result["pending"].append("incomplete export; explicit discard_incomplete required")
                    continue
                retention = record["plan"]["spec"]["retention"]
                if _due(retention["trees"], record["stopped_at"], force):
                    for resource in store.resources(record["id"]):
                        if resource["state"] == "released":
                            continue
                        if owner_alive(resource.get("operation_owner")):
                            result["pending"].append(f"live allocation: {resource['id']}")
                            continue
                        allocation = Path(resource["allocation_path"])
                        if resource["state"] == "reserved" and not os.path.lexists(allocation):
                            store.update_resource(
                                resource["id"],
                                state="released",
                                release={"state": "never-created"},
                                directory_removed=True,
                                directory_removal="never-created",
                            )
                            continue
                        store.verify_allocation(resource)
                        value = resource.get("tree") or await storage.recover_record(
                            resource["kind"],
                            allocation,
                            Path(resource["source"]) if resource["source"] else None,
                            stable=resource["stable"],
                        )
                        # Release is idempotent after a crash following successful OS deletion.
                        store.update_resource(resource["id"], state="deleting", tree=value)
                        released = await storage.release(value)
                        store.update_resource(resource["id"], state="released", release=released)
                        result["released"].append(resource["id"])
                await _remove_released_directories(hostfork, record["id"], result["pending"])
                remaining = [item for item in store.resources(record["id"]) if item["state"] != "released"]
                if _due(retention["evidence"], record["stopped_at"], force) and not remaining and not result["pending"]:
                    run = store.verify_run(record["id"])
                    # No live processes or mutation owners remain. Keep a registry tombstone.
                    record = store.update_environment(
                        record["id"], evidence_purge_intent={"path": str(run), "identity": path_identity(run)}
                    )
                    await _finish_purge(hostfork, record)
                    result["state"] = "purged"
                else:
                    store.update_environment(
                        record["id"], cleanup={"pending": result["pending"], "remaining_trees": len(remaining)}
                    )
        except Exception as error:
            result["pending"].append(str(error))
    if reclamation_timeout is not None:
        await _reconcile_reclamation(hostfork, environment_id, reclamation_timeout)
        for result in results:
            try:
                async with store.lock(result["id"], timeout=0.1):
                    await _remove_released_directories(hostfork, result["id"], result["pending"])
            except Exception as error:
                result["pending"].append(str(error))
    return results


def _disk_bytes(path: Path) -> dict:
    logical = allocated = files = 0
    errors = []
    for parent, _, names in os.walk(path, followlinks=False):
        for name in names:
            try:
                stat = (Path(parent) / name).lstat()
                logical += stat.st_size
                allocated += stat.st_blocks * 512
                files += 1
            except OSError as error:
                errors.append(str(error))
    return {"logical_bytes": logical, "allocated_bytes_not_exclusive": allocated, "files": files, "errors": errors}


async def usage(hostfork: Hostfork) -> dict:
    """Report capacity without summing shared Btrfs/reflink blocks as exclusive usage."""
    records = hostfork.store.environments()
    resources = hostfork.store.resources()
    paths = {
        str(hostfork.store.root / "trees"),
        *(str(path) for path in hostfork.pools.values()),
        *(item["pool"] for item in resources),
    }
    pools = {}
    for path in sorted(paths):
        try:
            pools[path] = await storage.usage(Path(path))
        except (OSError, RuntimeError) as error:
            pools[path] = {"error": str(error)}
    pending = [
        record
        for record in records
        if record["state"] in ("creating", "setup_failed", "cleanup_pending")
        or record.get("cleanup", {}).get("pending")
    ]
    return {
        "root": str(hostfork.store.root),
        "environments": len(records),
        "states": {
            state: sum(item["state"] == state for item in records) for state in sorted({r["state"] for r in records})
        },
        "pending_cleanup": len(pending),
        "oldest_pending_at": min((r["created_at"] for r in pending), default=None),
        "retained_trees": sum(item["state"] != "released" for item in resources),
        "retained_allocation_directories": sum(
            item["state"] == "released" and not item.get("directory_removed") for item in resources
        ),
        "pending_reclamation": sum(item.get("release", {}).get("reclamation") == "pending" for item in resources),
        "evidence": await asyncio.to_thread(_disk_bytes, hostfork.store.root / "runs"),
        "pools": pools,
        "exports": [export for record in records for export in record.get("exports", [])],
    }
