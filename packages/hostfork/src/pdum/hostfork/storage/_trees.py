"""Linux storage operations and serializable ownership records."""

from __future__ import annotations

import asyncio
import ctypes
import fcntl
import json
import os
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, TypeVar

TreeRecord = dict[str, Any]
_T = TypeVar("_T")
_TIMEOUT = 300.0
_OWNER = ".hostfork-owner.json"


class StorageError(RuntimeError):
    """An allocation, identity check or filesystem operation failed."""


async def _blocking(function: Callable[..., _T], *args: Any) -> _T:
    """Do not abandon an in-flight filesystem mutation when its caller cancels."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # Retrieve errors even when cancellation takes precedence. The durable
        # allocation intent remains the caller's recovery authority.
        if not task.cancelled():
            task.exception()
        raise


def _run(*argv: str | Path, timeout: float = _TIMEOUT, owned: bool = False) -> str:
    command = [str(value) for value in argv]
    if owned:
        command = [sys.executable, "-I", str(Path(__file__).with_name("_owned_exec.py")), str(os.getpid()), *command]
    with subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            # Helpers and their copy/mount utilities inherit this owned group.
            # Wait for their actual exit before another operation can reuse paths.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
    if process.returncode:
        raise StorageError(f"{Path(str(argv[0])).name} exited {process.returncode}: {stderr.strip()}")
    return stdout.strip()


def _btrfs(*args: str | Path, timeout: float = _TIMEOUT) -> str:
    binary = shutil.which("btrfs")
    if binary is None:
        raise StorageError("Btrfs operations require the btrfs-progs executable on PATH")
    owned = (
        (args[0] == "subvolume" and args[1] in {"snapshot", "delete", "create"})
        or (args[0] == "property" and args[1] == "set")
        or (args[0] == "filesystem" and args[1] == "sync")
    )
    return _run(binary, *args, timeout=timeout, owned=owned)


def _identity(path: Path) -> dict[str, Any]:
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode):
        raise StorageError(f"Expected an owned directory, not a symlink or other file: {path}")
    result = {
        "device": value.st_dev,
        "inode": value.st_ino,
        "filesystem_uuid": _run("findmnt", "-T", path, "-n", "-o", "UUID") or None,
    }
    try:
        # Inode numbers are unique only within a Btrfs subvolume. In particular,
        # every subvolume root has inode 256, including replacement snapshots.
        result["subvolume_uuid"] = _subvolume_info(path)["subvolume_uuid"]
    except StorageError:
        pass  # The ioctl is unavailable on other filesystems.
    return result


def _same_identity(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    # Device numbers can change across remount/reboot. A persistent filesystem
    # UUID plus inode is preferable when the filesystem supplies one.
    if actual.get("filesystem_uuid") and expected.get("filesystem_uuid"):
        return (actual["filesystem_uuid"], actual.get("subvolume_uuid"), actual["inode"]) == (
            expected["filesystem_uuid"],
            expected.get("subvolume_uuid"),
            expected["inode"],
        )
    return actual == expected


def _subvolume(path: Path) -> dict[str, Any]:
    if path.stat().st_ino != 256:
        raise StorageError(f"Not a Btrfs subvolume root: {path}")
    return _subvolume_info(path)


def _subvolume_info(path: Path) -> dict[str, Any]:
    # Linux UAPI linux/btrfs.h: GET_SUBVOL_INFO (504 bytes) and FS_INFO
    # (1024 bytes). Unlike `btrfs subvolume show`, these do not enumerate the
    # root tree using the privileged TREE_SEARCH operation.
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        subvolume, filesystem = bytearray(504), bytearray(1024)
        fcntl.ioctl(descriptor, 0x81F8943C, subvolume)
        fcntl.ioctl(descriptor, 0x8400941F, filesystem)
        return {
            "subvolume_id": struct.unpack_from("=Q", subvolume)[0],
            "subvolume_uuid": str(uuid.UUID(bytes=bytes(subvolume[296:312]))),
            "filesystem_uuid": str(uuid.UUID(bytes=bytes(filesystem[16:32]))),
        }
    except OSError as error:
        raise StorageError(f"Cannot identify Btrfs subvolume: {path}") from error
    finally:
        os.close(descriptor)


def _allocation(path: Path) -> tuple[Path, dict[str, Any]]:
    path = path.absolute()
    identity = _identity(path)
    marker = path / _OWNER
    if marker.is_symlink() or not marker.is_file():
        raise StorageError(f"Allocation directory requires the coordinator's {_OWNER} marker: {path}")
    try:
        json.loads(marker.read_text())
    except (ValueError, OSError) as error:
        raise StorageError(f"Unreadable allocation ownership marker: {path}") from error
    return path, identity


def _validate(kind: str, source: Path | None, stable: bool) -> dict[str, Any]:
    if kind not in {"copy", "btrfs", "overlay"}:
        raise StorageError(f"Unknown tree mechanism: {kind}")
    if source is None:
        if kind != "copy":
            raise StorageError(f"{kind} requires a source directory")
        return {"kind": kind, "source": None, "consistency": "empty"}
    source = source.resolve(strict=True)
    identity = _identity(source)
    result: dict[str, Any] = {
        "kind": kind,
        "source": str(source),
        "source_identity": identity,
        "stable": stable,
        "consistency": "operator-declared-stable" if stable else "live-copy",
    }
    if kind == "overlay":
        if not stable:
            raise StorageError("OverlayFS requires an explicitly stable lower tree")
        _overlay_path(source)
    elif kind == "btrfs":
        result["source_subvolume"] = _subvolume(source)
        if _btrfs("property", "get", "-ts", source, "ro") != "ro=true":
            raise StorageError("Btrfs baseline must be a prepared read-only subvolume")
        result["consistency"] = "snapshot"
    return result


async def validate_source(kind: str, source: Path | None, *, stable: bool = True) -> dict[str, Any]:
    """Validate storage prerequisites without allocating a tree.

    Parameters
    ----------
    kind
        ``copy``, ``btrfs`` or ``overlay``.
    source
        Prepared source directory, or None for an empty copy tree.
    stable
        Operator assertion that an overlay lower will remain unchanged.
    """
    return await _blocking(_validate, kind, source, stable)


def _overlay_path(path: Path) -> None:
    if any(character in str(path) for character in ":,\\\n"):
        raise StorageError("Overlay paths cannot contain colon, comma, backslash or newline")


def _allocate(kind: str, destination: Path, source: Path | None, stable: bool) -> TreeRecord:
    destination, _ = _allocation(destination)
    validated = _validate(kind, source, stable)
    source = Path(validated["source"]) if validated["source"] else None
    if source is not None and destination.resolve().is_relative_to(source):
        raise StorageError("Allocation directory cannot be inside the source tree")
    children = ("upper", "work") if kind == "overlay" else ("tree",)
    if any(os.path.lexists(destination / child) for child in children):
        raise StorageError("Ordinary allocation does not adopt existing tree paths; use recorded recovery")
    if kind == "btrfs":
        _btrfs("subvolume", "snapshot", source, destination / "tree")
    elif kind == "overlay":
        _overlay_path(destination)
        (destination / "upper").mkdir()
        (destination / "work").mkdir()
    else:
        tree = destination / "tree"
        tree.mkdir()
        if source is not None:
            # GNU cp preserves hardlink groups, symlinks, modes, timestamps and
            # supported xattrs. A real copy avoids unspecified reflink fallback.
            _run("cp", "-a", "--reflink=never", str(source) + "/.", tree, owned=True)
    record = _recover(kind, destination, source, stable)
    record["source_validation"] = validated
    record["allocation_complete"] = True
    return record


async def allocate(kind: str, destination: Path, source: Path | None = None, *, stable: bool = True) -> TreeRecord:
    """Allocate below a coordinator-reserved directory, never deleting borrowed inputs.

    Cancellation waits for the mutation to finish. The caller's durable intent
    can then recover deterministic children even if no result was delivered.
    """
    return await _blocking(_allocate, kind, destination, source, stable)


def _recover(kind: str, destination: Path, source: Path | None, stable: bool) -> TreeRecord:
    destination, owner_identity = _allocation(destination)
    if kind not in {"copy", "btrfs", "overlay"}:
        raise StorageError(f"Unknown tree mechanism: {kind}")
    source_path = str(source.absolute()) if source is not None else None
    record: TreeRecord = {
        "schema_version": 1,
        "kind": kind,
        "allocation_path": str(destination),
        "allocation_identity": owner_identity,
        "owner_marker": json.loads((destination / _OWNER).read_text()),
        "source": source_path,
        "stable": stable,
        "allocation_complete": False,
    }
    if kind == "overlay":
        if source is None:
            raise StorageError("Overlay recovery requires its recorded lower path")
        upper, work = destination / "upper", destination / "work"
        # Partial allocation remains releasable without requiring both children.
        record.update(
            path=None,
            upper=str(upper),
            work=str(work),
            identities={
                name: _identity(destination / name) for name in ("upper", "work") if (destination / name).exists()
            },
            mount={
                "kind": "overlay",
                "source": source_path,
                "upper": str(upper),
                "work": str(work),
                "options": ["userxattr"],
            },
        )
    else:
        tree = destination / "tree"
        record.update(
            path=str(tree),
            identity=_identity(tree) if tree.exists() else None,
            mount={"kind": "bind", "source": str(tree)},
        )
        if kind == "btrfs" and tree.exists():
            record["subvolume"] = _subvolume(tree)
    return record


async def recover_record(
    kind: str, destination: Path, source: Path | None = None, *, stable: bool = True
) -> TreeRecord:
    """Inspect deterministic allocation children after the coordinator verifies its intent.

    A recovered partial copy is not a completed copy and must not be launched
    without the coordinator's successful allocation observation.
    """
    return await _blocking(_recover, kind, destination, source, stable)


def _verify(record: TreeRecord) -> list[Path]:
    if not os.path.lexists(record["allocation_path"]):
        return []
    allocation, identity = _allocation(Path(record["allocation_path"]))
    if not _same_identity(identity, record["allocation_identity"]):
        raise StorageError("Allocation directory identity changed")
    if json.loads((allocation / _OWNER).read_text()) != record["owner_marker"]:
        raise StorageError("Allocation ownership marker changed")
    names = ("upper", "work") if record["kind"] == "overlay" else ("tree",)
    existing = []
    for name in names:
        path = allocation / name
        declared = record[name] if record["kind"] == "overlay" else record["path"]
        if str(path) != declared:
            raise StorageError("Tree path is outside its recorded allocation layout")
        expected = record["identities"].get(name) if record["kind"] == "overlay" else record["identity"]
        if not os.path.lexists(path):
            continue
        if expected is None or not _same_identity(_identity(path), expected):
            raise StorageError(f"Owned tree identity changed: {path}")
        if record["kind"] == "btrfs" and _subvolume(path) != record["subvolume"]:
            raise StorageError("Btrfs subvolume identity changed")
        existing.append(path)
    return existing


def _inspect(record: TreeRecord) -> dict[str, Any]:
    existing = _verify(record)
    expected = 2 if record["kind"] == "overlay" else 1
    result: dict[str, Any] = {
        "state": "present" if len(existing) == expected else "partial" if existing else "absent",
        "paths": [str(path) for path in existing],
        "kind": record["kind"],
        "measured_at": time.time(),
    }
    if record["kind"] == "overlay":
        result["lower_available"] = Path(record["source"]).is_dir()
        result["requires_stable_lower"] = True
    result["usage"] = _usage(Path(record["allocation_path"])) if Path(record["allocation_path"]).exists() else None
    return result


async def inspect(record: TreeRecord) -> dict[str, Any]:
    """Check owned identities and availability without recursively scanning contents."""
    return await _blocking(_inspect, record)


def _mounted_below(path: Path) -> bool:
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        encoded = line.split()[4]
        mountpoint = Path(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), encoded))
        if mountpoint == path or mountpoint.is_relative_to(path):
            return True
    return False


def _release(record: TreeRecord) -> dict[str, Any]:
    paths = _verify(record)
    for path in paths:
        if _mounted_below(path):
            raise StorageError(f"Refusing to remove an allocation with mounted children: {path}")
    for path in paths:
        if record["kind"] == "btrfs":
            # Retention may have made this owned snapshot read-only. This never
            # changes the borrowed source baseline.
            _btrfs("property", "set", "-ts", path, "ro", "false")
            _btrfs("subvolume", "delete", path)
        else:
            # A faithful copy may include read-only directories. Adjust only
            # owned directories for deletion, never linked targets or sources.
            path.chmod(path.stat().st_mode | stat.S_IRWXU)
            for directory, children, _ in os.walk(path, followlinks=False):
                owned = Path(directory)
                for name in children:
                    child = owned / name
                    if not child.is_symlink():
                        child.chmod(child.stat().st_mode | stat.S_IRWXU)
            shutil.rmtree(path)
    return {
        "state": "deleted",
        "allocation_directory_retained": True,
        "reclamation": "pending" if record["kind"] == "btrfs" else "not-measured",
        "subvolume": record.get("subvolume"),
    }


async def release(record: TreeRecord) -> dict[str, Any]:
    """Delete owned tree children after the coordinator confirms that users stopped.

    Btrfs deletion acknowledgment is recorded as pending reclamation. This call
    never waits for a filesystem-wide deletion queue or removes the allocation
    marker, source, or parent directory.
    """
    return await _blocking(_release, record)


def _confirm_reclamation(record: TreeRecord, timeout: float) -> dict[str, Any]:
    if record["kind"] != "btrfs":
        return {"state": "unavailable", "reason": "No backend reclamation confirmation"}
    if _verify(record):
        return {"state": "pending", "reason": "Snapshot path still exists"}
    location = Path(record["allocation_path"])
    if not location.exists():
        return {"state": "unavailable", "reason": "Recorded allocation root is unavailable"}
    expected = record.get("subvolume")
    if not expected:
        return {"state": "unavailable", "reason": "No recorded subvolume identity"}
    if _run("findmnt", "-T", location, "-n", "-o", "UUID") != expected["filesystem_uuid"]:
        raise StorageError("Reclamation filesystem identity changed")
    deadline = time.monotonic() + timeout
    try:
        _btrfs("filesystem", "sync", location, timeout=timeout)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"state": "pending", "reason": "Reclamation confirmation timed out"}
        _btrfs("subvolume", "sync", location, str(expected["subvolume_id"]), timeout=remaining)
    except subprocess.TimeoutExpired:
        return {"state": "pending", "reason": "Reclamation confirmation timed out"}
    except (StorageError, OSError) as error:
        return {"state": "unavailable", "error": str(error)}
    return {"state": "confirmed", "meaning": "Subvolume deletion completed; filesystem chunks may remain allocated"}


async def confirm_reclamation(record: TreeRecord, *, timeout: float = 5.0) -> dict[str, Any]:
    """Optionally wait for one deleted Btrfs subvolume, reporting missing privilege.

    This explicitly syncs the containing filesystem before waiting for the
    recorded subvolume ID. Default release never performs this pool-wide work.
    A timeout or unavailable inspection does not claim reclaimed capacity.
    """
    if timeout <= 0:
        raise ValueError("Reclamation timeout must be positive")
    return await _blocking(_confirm_reclamation, record, timeout)


def _rename_noreplace(source: Path, destination: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    operation = libc.renameat2
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int
    if operation(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def _durable_json(path: Path, value: dict[str, Any]) -> None:
    with path.open("x") as stream:
        json.dump(value, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _export_owner(record: TreeRecord, destination: Path) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "destination": str(destination),
        "allocation_path": record["allocation_path"],
        "allocation_identity": record["allocation_identity"],
        "owner_marker": record["owner_marker"],
    }


def _check_export_owner(value: dict[str, Any], record: TreeRecord, destination: Path) -> None:
    expected = _export_owner(record, destination)
    for key in ("schema_version", "destination", "allocation_path", "owner_marker"):
        if value.get(key) != expected[key]:
            raise StorageError("Export ownership receipt does not match the recorded allocation/destination")
    if not _same_identity(value.get("allocation_identity", {}), expected["allocation_identity"]):
        raise StorageError("Export allocation identity does not match its ownership receipt")


def _read_export_receipt(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise StorageError("Export receipt is absent or is not a regular file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise StorageError("Invalid export receipt")
    return value


def _recover_export(record: TreeRecord, destination: Path) -> dict[str, Any]:
    destination = destination.absolute()
    partial = destination.with_name(f".{destination.name}.hostfork-partial")
    receipt = destination.with_name(f".{destination.name}.hostfork-export.json")
    result = {"path": str(destination), "receipt": str(receipt), "partial_path": str(partial)}
    try:
        published = None
        if os.path.lexists(receipt):
            published = _read_export_receipt(receipt)
            _check_export_owner(published, record, destination)
        if os.path.lexists(destination):
            if published is None or not _same_identity(_identity(destination), published.get("tree_identity", {})):
                raise StorageError("Existing export destination lacks its matching publication receipt")
            return {**result, "state": "complete", "consistency": "not-verified-by-storage"}
        if os.path.lexists(partial):
            progress = _read_export_receipt(partial / "export.json")
            _check_export_owner(progress, record, destination)
            if not _same_identity(_identity(partial), progress.get("partial_identity", {})):
                raise StorageError("Partial export directory identity changed")
            if published and not _same_identity(_identity(partial / "tree"), published.get("tree_identity", {})):
                raise StorageError("Partial export tree does not match its publication receipt")
            return {
                **result,
                "state": "partial",
                "error": progress.get("error"),
                "publication_pending": bool(published),
            }
        return {**result, "state": "pending", "error": "No completed publication or owned partial export is available"}
    except (StorageError, OSError, ValueError) as error:
        return {**result, "state": "conflict", "error": str(error)}


async def recover_export(record: TreeRecord, destination: Path) -> dict[str, Any]:
    """Inspect a dead exporter's exact destination and retained ownership receipt.

    Recovery never adopts an existing destination by name alone. A completed
    export keeps a small ``.<name>.hostfork-export.json`` sibling to distinguish
    publication from caller death before its registry result was persisted.
    Partial exports are retained and reported; this operation does not retry.
    """
    return await _blocking(_recover_export, record, destination)


def _export(record: TreeRecord, destination: Path) -> dict[str, Any]:
    if not record.get("allocation_complete"):
        raise StorageError("Recovered allocation has no completion observation; only inspection/release is safe")
    if _inspect(record)["state"] != "present":
        raise StorageError("Cannot export an absent or partial private tree")
    destination = destination.absolute()
    if os.path.lexists(destination):
        raise FileExistsError(destination)
    allocation = Path(record["allocation_path"])
    if destination.resolve().is_relative_to(allocation.resolve()):
        raise StorageError("Export destination cannot be inside the private allocation")
    if record["kind"] == "overlay":
        source = Path(record["source"])
        expected = record["source_validation"]["source_identity"]
        if not _same_identity(_identity(source), expected):
            raise StorageError("Overlay lower directory identity changed")
        if destination.resolve().is_relative_to(source.resolve()):
            raise StorageError("Export destination cannot be inside the overlay lower tree")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Deterministic sibling supports recovery using an export intent containing
    # destination. Never reuse another attempt's partial directory.
    partial = destination.with_name(f".{destination.name}.hostfork-partial")
    receipt = destination.with_name(f".{destination.name}.hostfork-export.json")
    if os.path.lexists(receipt):
        raise FileExistsError(receipt)
    partial.mkdir()
    progress = {**_export_owner(record, destination), "state": "copying", "partial_identity": _identity(partial)}
    _durable_json(partial / "export.json", progress)
    tree = partial / "tree"
    tree.mkdir()
    try:
        if record["kind"] == "overlay":
            helper = Path(__file__).with_name("_overlay_export.py")
            specification = partial / "view.json"
            specification.write_text(json.dumps(record) + "\n")
            _run(
                "unshare",
                "--user",
                "--map-root-user",
                "--mount",
                "--propagation",
                "private",
                sys.executable,
                "-I",
                helper,
                specification,
                partial,
                str(os.getpid()),
                owned=True,
            )
        else:
            _run("cp", "-a", "--reflink=never", str(record["path"]) + "/.", tree, owned=True)
        _durable_json(receipt, {**_export_owner(record, destination), "tree_identity": _identity(tree)})
        _rename_noreplace(tree, destination)
        shutil.rmtree(partial)
        return {
            "state": "complete",
            "path": str(destination),
            "receipt": str(receipt),
            "consistency": "not-verified-by-storage",
        }
    except Exception as error:
        result = {"state": "failed", "path": str(destination), "partial_path": str(partial), "error": str(error)}
        try:
            (partial / "export.json").write_text(json.dumps({**progress, **result}) + "\n")
        except OSError:
            pass
        return result


async def export_tree(record: TreeRecord, destination: Path) -> dict[str, Any]:
    """Export stopped visible contents, retaining partial results on failure.

    Overlay reconstruction occurs in a fresh private namespace; the upper
    directory is never misrepresented as the complete view. Existing destinations
    and partial attempts are not overwritten. The caller journals destination.
    """
    return await _blocking(_export, record, destination)


def _usage(root: Path) -> dict[str, Any]:
    info = os.statvfs(root)
    result: dict[str, Any] = {
        "measured_at": time.time(),
        "capacity_bytes": info.f_blocks * info.f_frsize,
        "available_bytes": info.f_bavail * info.f_frsize,
        "free_bytes": info.f_bfree * info.f_frsize,
        "free_inodes": info.f_favail,
        "scope": "filesystem-pool",
        "exclusive_tree_bytes": None,
        "shared_tree_bytes": None,
    }
    result["filesystem"] = _run("findmnt", "-T", root, "-n", "-o", "FSTYPE")
    if result["filesystem"] == "btrfs":
        try:
            # Pool-level accounting only; no recursive tree walk or qgroup changes.
            result["btrfs_allocation"] = _btrfs("filesystem", "df", "--raw", root)
        except (StorageError, OSError) as error:
            result["accounting_error"] = str(error)
    return result


async def usage(root: Path) -> dict[str, Any]:
    """Report pool capacity without counting shared extents as exclusive run bytes."""
    return await _blocking(_usage, root)
