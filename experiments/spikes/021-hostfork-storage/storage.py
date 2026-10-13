"""Bounded, synthetic filesystem experiments; not a production storage manager."""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import json
import os
import platform
import resource
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


def command(*args: str | Path, timeout: float = 90) -> str:
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr.strip()}")
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)
    return result.stdout.strip()


def timed(operation: Any) -> tuple[Any, float]:
    start = time.perf_counter()
    value = operation()
    return value, (time.perf_counter() - start) * 1000


def summary(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "median": statistics.median(values),
        "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
        "min": min(values),
        "max": max(values),
    }


def tree_usage(path: Path) -> dict[str, int]:
    """Count inode blocks, which are not unique physical bytes for shared extents."""
    seen = set()
    logical = blocks = files = 0
    for item in path.rglob("*"):
        stat = item.lstat()
        identity = (stat.st_dev, stat.st_ino)
        if item.is_file() and not item.is_symlink() and identity not in seen:
            seen.add(identity)
            files += 1
            logical += stat.st_size
            blocks += stat.st_blocks * 512
    return {"regular_inodes": files, "logical_bytes": logical, "inode_allocated_bytes_not_exclusive": blocks}


def fixture(path: Path, large_mib: int, small_files: int) -> None:
    """Create actual non-sparse bytes plus hardlink, symlink and FIFO metadata."""
    (path / "small").mkdir()
    with (path / "large.bin").open("wb") as stream:
        for _ in range(large_mib):
            stream.write(os.urandom(1024 * 1024))
        stream.flush()
        os.fsync(stream.fileno())
    data = os.urandom(4096)
    for index in range(small_files):
        with (path / "small" / f"{index:06d}").open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    os.link(path / "small/000000", path / "hardlink")
    (path / "symlink").symlink_to("small/000000")
    os.mkfifo(path / "fifo")


def first_write(path: Path) -> None:
    with (path / "large.bin").open("r+b", buffering=0) as stream:
        stream.write(b"x" * 4096)
        os.fsync(stream.fileno())


def read_prefix(path: Path) -> bytes:
    with path.open("rb") as stream:
        return stream.read(4096)


def cpu_seconds() -> dict[str, float]:
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"caller": own.ru_utime + own.ru_stime, "child_utilities": children.ru_utime + children.ru_stime}


def modifications(path: Path) -> None:
    (path / "small/000001").unlink()
    (path / "small/000002").rename(path / "renamed")
    (path / "created").write_text("synthetic partial result\n")


def reclaim(btrfs: str, root: Path) -> dict[str, Any]:
    # Commit the deletion queue now instead of waiting for the periodic transaction.
    command(btrfs, "filesystem", "sync", root)
    try:
        command(btrfs, "subvolume", "sync", root)
    except RuntimeError as error:
        return {"confirmed": False, "error": str(error)}
    return {"confirmed": True}


def benchmark(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    filesystem = command("findmnt", "-T", root, "-n", "-o", "FSTYPE")
    baseline = root / "baseline"
    is_btrfs = filesystem == "btrfs"
    if is_btrfs:
        command(args.btrfs, "subvolume", "create", baseline)
    else:
        baseline.mkdir()
    _, prep_ms = timed(lambda: fixture(baseline, args.large_mib, args.small_files))
    if os.geteuid() == 0 and args.owner_uid:
        os.chown(baseline, args.owner_uid, args.owner_gid)
    if is_btrfs:
        command(args.btrfs, "property", "set", "-ts", baseline, "ro", "true")
        command(args.btrfs, "filesystem", "sync", root)
    source_prefix = read_prefix(baseline / "large.bin")
    result: dict[str, Any] = {
        "schema_version": 1,
        "recorded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kernel": platform.release(),
        "python": platform.python_version(),
        "coreutils": command("cp", "--version").splitlines()[0],
        "btrfs_progs": command(args.btrfs, "version") if is_btrfs else None,
        "filesystem": filesystem,
        "mount_options": command("findmnt", "-T", root, "-n", "-o", "OPTIONS"),
        "fixture": {"large_mib": args.large_mib, "small_files": args.small_files, **tree_usage(baseline)},
        "fixture_preparation_ms": prep_ms,
        "timing_contract": (
            "Warm cache; real utility subprocess time included. Clone acknowledgment is not crash durability. "
            "First write is 4 KiB overwrite plus fsync of the large file. Throughput excludes inspection, "
            "includes clone/write/metadata changes/delete, and separates Btrfs reclaim wait."
        ),
        "methods": [],
    }

    def clone(method: str, parent: Path) -> Path:
        parent.mkdir()
        view = parent / "view"
        if method == "snapshot":
            if not is_btrfs:
                raise RuntimeError("snapshot requires a prepared Btrfs filesystem")
            command(args.btrfs, "subvolume", "snapshot", baseline, view)
        elif method == "overlay":
            for name in ("upper", "work", "view"):
                (parent / name).mkdir()
            for component in (baseline, parent):
                if any(character in str(component) for character in ":,\\\n"):
                    raise ValueError("overlay experiment paths must not contain colon, comma, backslash or newline")
            options = f"lowerdir={baseline},upperdir={parent / 'upper'},workdir={parent / 'work'},userxattr"
            command("mount", "-t", "overlay", "overlay", "-o", options, view)
        else:
            reflink = "always" if method == "reflink" else "never"
            sparse = "auto" if method == "reflink" else "never"
            command("cp", "-a", f"--reflink={reflink}", f"--sparse={sparse}", baseline, view)
        return view

    def delete(method: str, parent: Path) -> None:
        view = parent / "view"
        if view.exists() and method == "snapshot":
            command(args.btrfs, "subvolume", "delete", view)
        elif view.exists() and method == "overlay" and os.path.ismount(view):
            command("umount", view)
        if parent.exists():
            shutil.rmtree(parent)

    def inspect(method: str, parent: Path) -> dict[str, Any]:
        view = clone(method, parent)
        try:
            data: dict[str, Any] = {"before_write": tree_usage(view)}
            data["symlink_preserved"] = (view / "symlink").is_symlink()
            data["fifo_preserved"] = (view / "fifo").is_fifo()
            data["hardlink_preserved_before_write"] = (view / "hardlink").stat().st_ino == (
                view / "small/000000"
            ).stat().st_ino
            first_write(view)
            modifications(view)
            if read_prefix(baseline / "large.bin") != source_prefix:
                raise AssertionError("source changed")
            data["source_write_isolated"] = True
            data["source_deleted_file_preserved"] = (baseline / "small/000001").exists()
            if not data["source_deleted_file_preserved"]:
                raise AssertionError("deletion changed source")
            data["after_write"] = tree_usage(view)
            if method == "overlay":
                data["upper_after_write"] = tree_usage(parent / "upper")
            if is_btrfs:
                measured_path = parent / "upper" if method == "overlay" else view
                data["btrfs_du_after_write"] = command(args.btrfs, "filesystem", "du", "--raw", "-s", measured_path)
                data["btrfs_du_path"] = "upper" if method == "overlay" else "view"
                data["filesystem_usage_after_write"] = command(args.btrfs, "filesystem", "usage", "-b", root)
            original_small = (baseline / "small/000000").read_bytes()
            (view / "small/000000").write_bytes(b"changed hardlink fixture")
            data["hardlink_alias_tracks_write"] = (view / "hardlink").read_bytes() == b"changed hardlink fixture"
            data["hardlink_source_unchanged"] = (baseline / "small/000000").read_bytes() == original_small
            return data
        finally:
            delete(method, parent)

    try:
        for method in args.methods:
            method_result: dict[str, Any] = {"method": method, "batches": []}
            result["methods"].append(method_result)
            check_path = root / f"{method}-inspection"
            try:
                if method == "reflink":
                    probe = root / "reflink-probe"
                    try:
                        command("cp", "--reflink=always", baseline / "large.bin", probe)
                    finally:
                        probe.unlink(missing_ok=True)
                method_result["inspection"] = inspect(method, check_path)
            except (RuntimeError, OSError) as error:
                method_result["unavailable"] = str(error)
                delete(method, check_path)
                continue
            for workers in args.workers:
                samples: list[dict[str, float]] = []

                def run(index: int) -> dict[str, float]:
                    parent = root / f"{method}-{workers}-{index}"
                    try:
                        view, clone_ms = timed(lambda: clone(method, parent))
                        _, write_ms = timed(lambda: first_write(view))
                        _, changes_ms = timed(lambda: modifications(view))
                    finally:
                        _, delete_ms = timed(lambda: delete(method, parent))
                    return {
                        "clone": clone_ms,
                        "first_write_fsync": write_ms,
                        "changes": changes_ms,
                        "delete": delete_ms,
                    }

                start = time.perf_counter()
                cpu_start = cpu_seconds()
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
                    samples = list(executor.map(run, range(args.iterations)))
                elapsed = time.perf_counter() - start
                cpu_end = cpu_seconds()
                cpu_elapsed = {key: cpu_end[key] - cpu_start[key] for key in cpu_start}
                reclaim_ms = None
                reclaim_status = None
                if is_btrfs:
                    # Deletion acknowledgment and space reclamation are deliberately separate.
                    reclaim_status, reclaim_ms = timed(lambda: reclaim(args.btrfs, root))
                method_result["batches"].append(
                    {
                        "workers": workers,
                        "iterations": args.iterations,
                        "wall_seconds": elapsed,
                        "cpu_seconds": cpu_elapsed,
                        "lifecycles_per_second": args.iterations / elapsed,
                        "reclaim_wait_ms": reclaim_ms,
                        "reclaim_status": reclaim_status,
                        "lifecycles_per_second_including_reclaim": args.iterations
                        / (elapsed + (reclaim_ms or 0) / 1000),
                        "milliseconds": {key: summary([sample[key] for sample in samples]) for key in samples[0]},
                        "samples_ms": samples,
                    }
                )
        result["source_prefix_unchanged"] = read_prefix(baseline / "large.bin") == source_prefix
        if is_btrfs:
            result["btrfs_semantics"] = btrfs_semantics(args, root)
            if args.runtime_check:
                if os.geteuid() == 0 and args.owner_uid:
                    result["runtime_integration"] = json.loads(
                        command(
                            "setpriv",
                            "--reuid",
                            str(args.owner_uid),
                            "--regid",
                            str(args.owner_gid),
                            "--clear-groups",
                            sys.executable,
                            Path(__file__).resolve(),
                            "_runtime",
                            "--root",
                            root,
                            "--btrfs",
                            args.btrfs,
                        )
                    )
                else:
                    result["runtime_integration"] = asyncio.run(runtime_integration(args, root, baseline))
    finally:
        if is_btrfs:
            command(args.btrfs, "property", "set", "-ts", baseline, "ro", "false")
            command(args.btrfs, "subvolume", "delete", baseline)
            result["final_reclaim_status"] = reclaim(args.btrfs, root)
        else:
            shutil.rmtree(baseline)
    result["remaining_paths"] = [path.name for path in root.iterdir()]
    if result["remaining_paths"]:
        raise AssertionError(f"unreaped paths: {result['remaining_paths']}")
    return result


def btrfs_semantics(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    """Probe snapshot boundaries and owned-subvolume operations with a normal UID."""
    source, clone, nested = root / "semantic-source", root / "semantic-clone", root / "semantic-source/nested"
    command(args.btrfs, "subvolume", "create", source)
    command(args.btrfs, "subvolume", "create", nested)
    (nested / "marker").write_text("not recursive\n")
    source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(f"/proc/self/fd/{source_fd}/socket")
    listener.listen(2)
    os.mkfifo(source / "fifo")
    reader_fd = os.open(source / "fifo", os.O_RDONLY | os.O_NONBLOCK)
    command(args.btrfs, "subvolume", "snapshot", source, clone)
    result: dict[str, Any] = {"nested_subvolume_directory_present": (clone / "nested").is_dir()}
    result["nested_subvolume_contents_present"] = (clone / "nested/marker").exists()
    for name, tree in (("source", source), ("snapshot", clone)):
        directory_fd = os.open(tree, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                try:
                    client.connect(f"/proc/self/fd/{directory_fd}/socket")
                    result[f"{name}_live_socket_connect"] = "connected"
                except OSError as error:
                    result[f"{name}_live_socket_connect"] = {"errno": error.errno, "message": error.strerror}
            try:
                writer_fd = os.open(tree / "fifo", os.O_WRONLY | os.O_NONBLOCK)
                os.close(writer_fd)
                result[f"{name}_live_fifo_open"] = "opened"
            except OSError as error:
                result[f"{name}_live_fifo_open"] = {"errno": error.errno, "message": error.strerror}
        finally:
            os.close(directory_fd)
    os.close(reader_fd)
    listener.close()
    os.close(source_fd)
    command(args.btrfs, "subvolume", "delete", clone)
    command(args.btrfs, "subvolume", "delete", nested)
    command(args.btrfs, "subvolume", "delete", source)
    if os.geteuid() == 0 and args.owner_uid:
        owned = root / "owned"
        owned.mkdir()
        os.chown(owned, args.owner_uid, args.owner_gid)
        prefix = ["setpriv", "--reuid", str(args.owner_uid), "--regid", str(args.owner_gid), "--clear-groups"]
        try:
            command(*prefix, args.btrfs, "subvolume", "create", owned / "source")
            command(*prefix, args.btrfs, "subvolume", "snapshot", owned / "source", owned / "snapshot")
            result["unprivileged_snapshot_uid"] = (owned / "snapshot").stat().st_uid
            command(*prefix, args.btrfs, "subvolume", "delete", owned / "snapshot", owned / "source")
            result["unprivileged_create_snapshot_delete"] = True
            # The public prepared-root mode also uses a user/mount namespace.
            prepared = json.loads(
                command(
                    *prefix,
                    "unshare",
                    "--user",
                    "--map-root-user",
                    "--mount",
                    "--propagation",
                    "private",
                    sys.executable,
                    Path(__file__).resolve(),
                    "_benchmark",
                    "--root",
                    owned,
                    "--btrfs",
                    args.btrfs,
                    "--methods",
                    "snapshot",
                    "--iterations",
                    "1",
                    "--workers",
                    "1",
                    "--large-mib",
                    "1",
                    "--small-files",
                    "3",
                )
            )
            result["unprivileged_prepared_root_benchmark"] = {
                "remaining_paths": prepared["remaining_paths"],
                "snapshot_available": "unavailable" not in prepared["methods"][0],
                "reclaim_status": prepared["methods"][0]["batches"][0]["reclaim_status"],
            }
        except RuntimeError as error:
            result["unprivileged_probe_error"] = str(error)
        finally:
            for name in ("snapshot", "source", "snapshot-inspection/view", "baseline"):
                if (owned / name).exists():
                    command(args.btrfs, "subvolume", "delete", owned / name)
            shutil.rmtree(owned)
    reclaim(args.btrfs, root)
    return result


async def runtime_integration(args: argparse.Namespace, root: Path, baseline: Path) -> dict[str, Any]:
    """Bind a real writable snapshot into spike 020, then close before deleting storage."""
    from hostfork_spike.runtime import Environment, EnvironmentSpec, Mount

    snapshot, target, artifacts = root / "runtime-snapshot", root / "runtime-target", root / "runtime-artifacts"
    command(args.btrfs, "subvolume", "snapshot", baseline, snapshot)
    target.mkdir()
    environment = None
    try:
        start = time.perf_counter()
        environment = await Environment.create(
            EnvironmentSpec(mounts=[Mount("bind", str(target), str(snapshot))], deadline_seconds=15),
            artifact_root=artifacts,
        )
        startup_ms = (time.perf_counter() - start) * 1000
        process = await environment.run(
            [
                sys.executable,
                "-c",
                "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('snapshot result')",
                str(target / "runtime-result"),
            ]
        )
        final = await environment.close()
        environment = None
        result = {
            "environment_startup_ms": startup_ms,
            "returncode": process.get("returncode"),
            "final_state": final,
            "snapshot_contains_result": (snapshot / "runtime-result").read_text() == "snapshot result",
            "baseline_unchanged": not (baseline / "runtime-result").exists(),
            "host_target_unchanged": not (target / "runtime-result").exists(),
        }
        if result["returncode"] != 0 or not all(
            result[key]
            for key in (
                "snapshot_contains_result",
                "baseline_unchanged",
                "host_target_unchanged",
            )
        ):
            raise AssertionError(f"runtime integration failed: {result}")
        return result
    except Exception as error:
        return {
            "error": str(error),
            "evidence": {
                str(path.relative_to(artifacts)): path.read_text()
                for path in artifacts.rglob("*")
                if path.is_file() and path.suffix in (".json", ".log")
            },
        }
    finally:
        if environment is not None:
            await environment.close()
        command(args.btrfs, "subvolume", "delete", snapshot)
        target.rmdir()
        if artifacts.exists():
            shutil.rmtree(artifacts)


def child_args(args: argparse.Namespace) -> list[str]:
    return [
        *(["--runtime-check"] if args.runtime_check else []),
        "--btrfs",
        args.btrfs,
        "--iterations",
        str(args.iterations),
        "--large-mib",
        str(args.large_mib),
        "--small-files",
        str(args.small_files),
        "--workers",
        *map(str, args.workers),
        "--methods",
        *args.methods,
    ]


def image_run(args: argparse.Namespace) -> dict[str, Any]:
    """Format only a newly created regular file, with mounts confined to a child namespace."""
    args.root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="btrfs-image-", dir=args.root) as temporary:
        directory = Path(temporary).resolve()
        # Permit the optional unprivileged ownership probe through this synthetic fixture parent.
        directory.chmod(0o755)
        image = directory / "disposable.img"
        with image.open("xb") as stream:
            stream.truncate(args.image_mib * 1024 * 1024)
        mountpoint = directory / "mount"
        mountpoint.mkdir()
        _, format_ms = timed(lambda: command(args.mkfs, image))
        data = command(
            "sudo",
            "-n",
            "timeout",
            "--signal=TERM",
            "--kill-after=5",
            "600",
            "unshare",
            "--mount",
            "--propagation",
            "private",
            sys.executable,
            Path(__file__).resolve(),
            "_image",
            "--root",
            mountpoint,
            "--image",
            image,
            "--owner-uid",
            str(os.getuid()),
            "--owner-gid",
            str(os.getgid()),
            *child_args(args),
            timeout=615,
        )
        result = json.loads(data)
        result["image_preparation"] = {"virtual_bytes": image.stat().st_size, "mkfs_ms": format_ms}
        result["image_allocated_bytes_after_unmount"] = image.stat().st_blocks * 512
        result["loop_mappings_after_namespace_exit"] = command("sudo", "-n", "losetup", "-j", image)
        if result["loop_mappings_after_namespace_exit"]:
            raise AssertionError("disposable loop device still attached")
        result["mount_visible_in_parent_after_exit"] = os.path.ismount(mountpoint)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["benchmark", "image-run", "_benchmark", "_image", "_runtime"])
    parser.add_argument(
        "--root", type=Path, required=True, help="Scratch directory on target filesystem; unique child created"
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--btrfs", default="btrfs")
    parser.add_argument("--mkfs", default="mkfs.btrfs")
    parser.add_argument(
        "--methods",
        nargs="+",
        choices=["copy", "reflink", "overlay", "snapshot"],
        default=["copy", "reflink", "overlay", "snapshot"],
    )
    parser.add_argument("--workers", nargs="+", type=int, default=[1, 4])
    parser.add_argument("--iterations", type=int, default=12)
    parser.add_argument("--large-mib", type=int, default=64)
    parser.add_argument("--small-files", type=int, default=1000)
    parser.add_argument("--image-mib", type=int, default=2048)
    parser.add_argument("--runtime-check", action="store_true", help="Also test a snapshot mounted by spike 020")
    parser.add_argument("--image", type=Path)
    parser.add_argument("--owner-uid", type=int, default=0)
    parser.add_argument("--owner-gid", type=int, default=0)
    args = parser.parse_args()
    if min(args.workers) < 1 or args.iterations < 1 or args.large_mib < 1 or args.small_files < 3:
        parser.error("workers, iterations and large-mib must be positive; small-files must be at least 3")
    args.root = args.root.resolve()
    for attribute in ("btrfs", "mkfs"):
        executable = getattr(args, attribute)
        if "/" in executable:
            setattr(args, attribute, str(Path(executable).resolve()))
    if args.action == "image-run":
        result = image_run(args)
    elif args.action == "benchmark":
        args.root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="storage-", dir=args.root) as temporary:
            result = json.loads(
                command(
                    "unshare",
                    "--user",
                    "--map-root-user",
                    "--mount",
                    "--propagation",
                    "private",
                    sys.executable,
                    Path(__file__).resolve(),
                    "_benchmark",
                    "--root",
                    temporary,
                    *child_args(args),
                    timeout=600,
                )
            )
    elif args.action == "_image":
        if args.image is None or not args.image.is_file() or args.image.is_symlink():
            parser.error("_image requires a regular disposable image")
        _, mount_ms = timed(lambda: command("mount", "-o", "loop,user_subvol_rm_allowed", args.image, args.root))
        try:
            args.root.chmod(0o755)
            os.chown(args.root, args.owner_uid, args.owner_gid)
            result = benchmark(args, args.root)
            result["image_mount_ms"] = mount_ms
        finally:
            _, unmount_ms = timed(lambda: command("umount", args.root))
        result["image_unmount_ms"] = unmount_ms
    elif args.action == "_runtime":
        result = asyncio.run(runtime_integration(args, args.root, args.root / "baseline"))
    else:
        result = benchmark(args, args.root)
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n")
        print(args.output)
    else:
        print(payload)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    main()
