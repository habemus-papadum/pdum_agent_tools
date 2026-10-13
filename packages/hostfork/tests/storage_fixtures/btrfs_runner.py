"""Run prepared-root tests on a disposable Btrfs image in a private namespace.

Example from the repository root (no global package installation):

uv run --frozen python packages/hostfork/tests/storage_fixtures/btrfs_runner.py \
  --tools experiments/artifacts/021-hostfork-storage/tools/root

Only a newly created regular image file is formatted. Tests themselves run as
the invoking ordinary user. This fixture is not imported by production code.
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--child", action="store_true")
    parser.add_argument(
        "--root-tests", action="store_true", help="Run storage-only tests as root for reclamation checks"
    )
    parser.add_argument("--image", type=Path)
    parser.add_argument("--mountpoint", type=Path)
    parser.add_argument("--uid", type=int)
    parser.add_argument("--gid", type=int)
    args = parser.parse_args()
    args.tools = args.tools.resolve()
    repository = Path(__file__).resolve().parents[4]
    if args.child:
        subprocess.run(
            ["mount", "-o", "loop,user_subvol_rm_allowed", str(args.image), str(args.mountpoint)], check=True
        )
        try:
            os.chown(args.mountpoint, args.uid, args.gid)
            environment = os.environ | {
                "PATH": str(args.tools / "bin") + ":" + os.environ["PATH"],
                "PDUM_HOSTFORK_TEST_BTRFS_ROOT": str(args.mountpoint),
                "PDUM_HOSTFORK_REQUIRE_BTRFS": "1",
            }
            tests = [str(repository / "packages/hostfork/tests/test_storage.py")]
            if not args.root_tests:
                environment.update(
                    XDG_RUNTIME_DIR=f"/run/user/{args.uid}",
                    DBUS_SESSION_BUS_ADDRESS=f"unix:path=/run/user/{args.uid}/bus",
                    PDUM_HOSTFORK_REQUIRE_LINUX="1",
                )
                tests.append(str(repository / "packages/hostfork/tests/test_btrfs_environment.py"))
            completed = subprocess.run(
                [
                    *(
                        []
                        if args.root_tests
                        else [
                            "setpriv",
                            "--reuid",
                            str(args.uid),
                            "--regid",
                            str(args.gid),
                            "--clear-groups",
                        ]
                    ),
                    sys.executable,
                    "-m",
                    "pytest",
                    "-q",
                    *tests,
                    "-k",
                    "btrfs",
                    "--basetemp",
                    str(args.mountpoint / "pytest-state"),
                ],
                env=environment,
                cwd=repository,
            )
        finally:
            subprocess.run(["umount", str(args.mountpoint)], check=True)
        raise SystemExit(completed.returncode)
    artifact_root = repository / "artifacts" / "hostfork-storage"
    artifact_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="btrfs-", dir=artifact_root) as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        image = root / "disposable.img"
        with image.open("xb") as stream:
            stream.truncate(512 * 1024 * 1024)
        mountpoint = root / "mount"
        mountpoint.mkdir()
        subprocess.run([str(args.tools / "sbin/mkfs.btrfs"), str(image)], check=True, capture_output=True)
        completed = subprocess.run(
            [
                "sudo",
                "-n",
                "timeout",
                "--kill-after=5",
                "90",
                "unshare",
                "--mount",
                "--propagation",
                "private",
                sys.executable,
                str(Path(__file__).resolve()),
                "--child",
                *(["--root-tests"] if args.root_tests else []),
                "--tools",
                str(args.tools),
                "--image",
                str(image),
                "--mountpoint",
                str(mountpoint),
                "--uid",
                str(os.getuid()),
                "--gid",
                str(os.getgid()),
            ],
            timeout=110,
        )
        mappings = subprocess.run(
            ["sudo", "-n", "losetup", "-j", str(image)], check=True, capture_output=True, text=True
        )
        if mappings.stdout.strip() or os.path.ismount(mountpoint):
            raise RuntimeError("Disposable Btrfs mount or loop mapping remains")
        raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
