"""Real filesystem behavior and injected allocation failure coverage."""

import asyncio
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from pdum.hostfork import storage
from pdum.hostfork.storage import _trees

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux storage utilities and namespace helpers")


def reserve(path: Path) -> Path:
    path.mkdir()
    (path / ".hostfork-owner.json").write_text(json.dumps({"allocation_id": path.name}))
    return path


@pytest.fixture
def source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    (source / "data").write_bytes(b"original data")
    (source / "data").chmod(0o640)
    os.link(source / "data", source / "alias")
    (source / "link").symlink_to("data")
    (source / "directory").mkdir()
    (source / "directory" / "deleted").write_text("delete in private view")
    (source / "directory").chmod(0o555)
    os.mkfifo(source / "fifo")
    return source


async def test_copy_preserves_metadata_and_private_writes(source: Path, tmp_path: Path) -> None:
    allocation = reserve(tmp_path / "allocation")
    try:
        os.setxattr(source / "data", "user.hostfork-test", b"value")
        xattrs = True
    except OSError:
        xattrs = False
    record = await storage.allocate("copy", allocation, source)
    copied = Path(record["path"])
    assert (copied / "data").stat().st_ino == (copied / "alias").stat().st_ino
    assert (copied / "data").stat().st_ino != (source / "data").stat().st_ino
    assert stat.S_IMODE((copied / "data").stat().st_mode) == 0o640
    assert (copied / "data").stat().st_mtime_ns == (source / "data").stat().st_mtime_ns
    assert (copied / "link").readlink() == Path("data")
    assert (copied / "fifo").is_fifo()
    if xattrs:
        assert os.getxattr(copied / "data", "user.hostfork-test") == b"value"
    (copied / "data").write_text("private write")
    assert (copied / "alias").read_text() == "private write"
    assert (source / "data").read_text() == "original data"
    result = await storage.export_tree(record, tmp_path / "export")
    assert result["state"] == "complete"
    assert Path(result["receipt"]).is_file()
    assert (await storage.recover_export(record, tmp_path / "export"))["state"] == "complete"
    assert (tmp_path / "export" / "alias").read_text() == "private write"
    assert (tmp_path / "export" / "link").is_symlink()
    assert (await storage.release(record))["state"] == "deleted"
    assert (allocation / ".hostfork-owner.json").exists()
    assert not copied.exists()
    assert (source / "directory" / "deleted").exists()
    assert (await storage.release(record))["state"] == "deleted"


async def test_empty_copy_and_cheap_pool_usage(tmp_path: Path) -> None:
    record = await storage.allocate("copy", reserve(tmp_path / "allocation"))
    assert list(Path(record["path"]).iterdir()) == []
    assert (await storage.inspect(record))["state"] == "present"
    measured = await storage.usage(tmp_path)
    assert measured["capacity_bytes"] > 0
    assert measured["exclusive_tree_bytes"] is None
    await storage.release(record)


async def test_source_and_existing_destination_guards(source: Path, tmp_path: Path) -> None:
    with pytest.raises(storage.StorageError, match="stable"):
        await storage.validate_source("overlay", source, stable=False)
    with pytest.raises(storage.StorageError, match="inside the source"):
        await storage.allocate("copy", reserve(source / "allocation"), source)
    allocation = reserve(tmp_path / "allocation")
    (allocation / "tree").mkdir()
    (allocation / "tree" / "existing").write_text("keep")
    with pytest.raises(storage.StorageError, match="existing"):
        await storage.allocate("copy", allocation, source)
    assert (allocation / "tree" / "existing").read_text() == "keep"


async def test_release_refuses_changed_marker_or_replaced_symlink(source: Path, tmp_path: Path) -> None:
    allocation = reserve(tmp_path / "allocation")
    record = await storage.allocate("copy", allocation, source)
    marker = allocation / ".hostfork-owner.json"
    original = marker.read_text()
    marker.write_text('{"allocation_id":"another-owner"}')
    with pytest.raises(storage.StorageError, match="marker"):
        await storage.release(record)
    marker.write_text(original)
    tree = Path(record["path"])
    tree.rename(allocation / "moved")
    tree.symlink_to(source, target_is_directory=True)
    with pytest.raises(storage.StorageError, match="symlink"):
        await storage.release(record)
    assert (source / "data").read_text() == "original data"


async def test_crash_gap_record_can_release_partial_tree(source: Path, tmp_path: Path) -> None:
    allocation = reserve(tmp_path / "allocation")
    (allocation / "tree").mkdir()
    (allocation / "tree" / "partial").write_text("partial copy")
    record = await storage.recover_record("copy", allocation, source)
    assert record["allocation_complete"] is False
    with pytest.raises(storage.StorageError, match="completion"):
        await storage.export_tree(record, tmp_path / "export")
    await storage.release(record)
    assert not (allocation / "tree").exists()


async def test_cancellation_waits_for_mutation_and_leaves_recoverable_record(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started, finish = threading.Event(), threading.Event()
    original = _trees._run

    def gated(*args, **kwargs):
        if args[0] == "cp":
            started.set()
            assert finish.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(_trees, "_run", gated)
    allocation = reserve(tmp_path / "allocation")
    pending = asyncio.create_task(storage.allocate("copy", allocation, source))
    assert await asyncio.to_thread(started.wait, 5)
    pending.cancel()
    await asyncio.sleep(0.02)
    assert not pending.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await pending
    recovered = await storage.recover_record("copy", allocation, source)
    assert (Path(recovered["path"]) / "data").read_text() == "original data"
    await storage.release(recovered)


async def test_export_preserves_partial_failure_and_never_overwrites(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = await storage.allocate("copy", reserve(tmp_path / "allocation"), source)
    destination = tmp_path / "existing"
    destination.mkdir()
    with pytest.raises(FileExistsError):
        await storage.export_tree(record, destination)
    original = _trees._run

    def fail_copy(*args, **kwargs):
        if args[0] == "cp":
            (Path(args[-1]) / "partial").write_text("forensic bytes")
            raise storage.StorageError("injected copy failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(_trees, "_run", fail_copy)
    result = await storage.export_tree(record, tmp_path / "failed")
    assert result["state"] == "failed"
    assert (Path(result["partial_path"]) / "tree" / "partial").read_text() == "forensic bytes"
    assert not (tmp_path / "failed").exists()
    assert (await storage.recover_export(record, tmp_path / "failed"))["state"] == "partial"
    await storage.release(record)


async def test_export_recovery_validates_publication_identity(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = await storage.allocate("copy", reserve(tmp_path / "allocation"), source)
    destination = tmp_path / "export"
    original = _trees._rename_noreplace

    def interrupted(source, destination):
        original(source, destination)
        raise OSError("injected death after publication")

    monkeypatch.setattr(_trees, "_rename_noreplace", interrupted)
    assert (await storage.export_tree(record, destination))["state"] == "failed"
    assert (await storage.recover_export(record, destination))["state"] == "complete"
    destination.rename(tmp_path / "moved-export")
    destination.mkdir()
    assert (await storage.recover_export(record, destination))["state"] == "conflict"
    arbitrary = tmp_path / "arbitrary"
    arbitrary.mkdir()
    assert (await storage.recover_export(record, arbitrary))["state"] == "conflict"
    assert (await storage.recover_export(record, tmp_path / "unstarted"))["state"] == "pending"
    await storage.release(record)


async def test_mutating_utility_dies_when_caller_is_killed(tmp_path: Path) -> None:
    marker = tmp_path / "utility-pid"
    utility = "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
    launcher = "import sys; from pdum.hostfork.storage._trees import _run; _run(*sys.argv[1:], owned=True)"
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        launcher,
        sys.executable,
        "-c",
        utility,
        str(marker),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    child_pid = None
    try:
        for _ in range(200):
            if marker.exists():
                child_pid = int(marker.read_text())
                break
            await asyncio.sleep(0.01)
        assert child_pid is not None
        owner.kill()
        await asyncio.wait_for(owner.communicate(), 5)
        for _ in range(200):
            try:
                state = Path(f"/proc/{child_pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except FileNotFoundError:
                return
            if state == "Z":
                return  # The kernel has killed it; its new parent owns wait/reaping.
            await asyncio.sleep(0.01)
        pytest.fail("Mutating storage utility survived caller death")
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.communicate()


async def test_overlay_export_reconstructs_deletions_after_namespace_exit(source: Path, tmp_path: Path) -> None:
    if sys.platform != "linux" or shutil.which("unshare") is None:
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
            pytest.fail("Required Linux unshare capability is absent")
        pytest.skip("Linux unshare is required")
    capability = subprocess.run(
        ["unshare", "--user", "--map-root-user", "--mount", "true"], capture_output=True, text=True
    )
    if capability.returncode:
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
            pytest.fail(f"Required namespace capability failed: {capability.stderr.strip()}")
        pytest.skip(f"User/mount namespaces unavailable: {capability.stderr.strip()}")
    record = await storage.allocate("overlay", reserve(tmp_path / "allocation"), source)
    merged = tmp_path / "merged"
    merged.mkdir()
    options = f"lowerdir={source},upperdir={record['upper']},workdir={record['work']},userxattr"
    program = """
import os, pathlib, subprocess, sys
view=pathlib.Path(sys.argv[1])
subprocess.run(['mount','-t','overlay','overlay','-o',sys.argv[2],str(view)],check=True)
try:
    (view/'data').unlink()
    (view/'directory').chmod(0o755)
    (view/'directory'/'deleted').unlink()
    (view/'new').write_text('private')
    (view/'link').unlink()
    (view/'link').symlink_to('new')
finally:
    subprocess.run(['umount',str(view)],check=True)
"""
    try:
        process = await asyncio.create_subprocess_exec(
            "unshare",
            "--user",
            "--map-root-user",
            "--mount",
            "--propagation",
            "private",
            sys.executable,
            "-c",
            program,
            str(merged),
            options,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        assert process.returncode == 0, stderr.decode()
        assert not os.path.ismount(merged)
        result = await storage.export_tree(record, tmp_path / "export")
        assert result["state"] == "complete", result
        exported = tmp_path / "export"
        assert not (exported / "data").exists()
        assert not (exported / "directory" / "deleted").exists()
        assert (exported / "new").read_text() == "private"
        assert (exported / "link").readlink() == Path("new")
        assert (source / "data").exists()
        assert (source / "directory" / "deleted").exists()
    finally:
        await storage.release(record)


@pytest.mark.hostfork_btrfs
async def test_btrfs_prepared_root(tmp_path: Path) -> None:
    prepared = os.environ.get("PDUM_HOSTFORK_TEST_BTRFS_ROOT")
    if not prepared or not shutil.which("btrfs"):
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_BTRFS") == "1":
            pytest.fail("Required prepared Btrfs root or btrfs tools unavailable")
        pytest.skip("Set PDUM_HOSTFORK_TEST_BTRFS_ROOT to an owned prepared Btrfs scratch root")
    import tempfile

    with tempfile.TemporaryDirectory(prefix="hostfork-storage-test-", dir=prepared) as temporary:
        root = Path(temporary)
        baseline = root / "baseline"
        _trees._btrfs("subvolume", "create", baseline)
        record = None
        try:
            (baseline / "data").write_text("baseline")
            _trees._btrfs("property", "set", "-ts", baseline, "ro", "true")
            record = await storage.allocate("btrfs", reserve(root / "allocation"), baseline)
            tree = Path(record["path"])
            (tree / "data").write_text("snapshot")
            assert (baseline / "data").read_text() == "baseline"
            assert record["subvolume"]["subvolume_uuid"]
            assert record["subvolume"]["filesystem_uuid"]
            result = await storage.export_tree(record, tmp_path / "export")
            assert result["state"] == "complete"
            assert (tmp_path / "export" / "data").read_text() == "snapshot"
            deletion = await storage.release(record)
            assert deletion["state"] == "deleted"
            assert deletion["reclamation"] == "pending"
            assert (await storage.release(record))["state"] == "deleted"
            confirmation = await storage.confirm_reclamation(record, timeout=2)
            if os.geteuid() == 0:
                assert confirmation["state"] == "confirmed", confirmation
            else:
                assert confirmation["state"] in {"confirmed", "unavailable"}, confirmation
            # Btrfs roots all use inode 256: filesystem UUID + inode alone
            # must not mistake a replacement lower subvolume for the original.
            overlay = await storage.allocate("overlay", reserve(root / "overlay"), baseline)
            original = root / "original-baseline"
            baseline.rename(original)
            try:
                _trees._btrfs("subvolume", "snapshot", "-r", original, baseline)
                with pytest.raises(storage.StorageError, match="lower directory identity changed"):
                    await storage.export_tree(overlay, tmp_path / "replaced-lower-export")
            finally:
                await storage.release(overlay)
                if baseline.exists():
                    _trees._btrfs("property", "set", "-ts", baseline, "ro", "false")
                    _trees._btrfs("subvolume", "delete", baseline)
                original.rename(baseline)
        finally:
            if record is not None:
                await storage.release(record)
            _trees._btrfs("property", "set", "-ts", baseline, "ro", "false")
            _trees._btrfs("subvolume", "delete", baseline)
