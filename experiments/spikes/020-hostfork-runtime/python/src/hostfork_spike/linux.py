"""Small Linux primitives; imported before entering a namespace."""

import ctypes
import os
import shutil
import signal
from pathlib import Path

CLONE_NEWUSER = 0x10000000
CLONE_NEWNS = 0x00020000
CLONE_NEWPID = 0x20000000
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18
MS_REMOUNT = 32
MS_RDONLY = 1
_libc = ctypes.CDLL(None, use_errno=True)


def parent_death_signal(sig: int) -> None:
    if _libc.prctl(1, sig, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG)")


def remove_overlay_work(artifact_path: Path, mounts: list[dict]) -> list[dict]:
    """Remove kernel scratch only after the owned mount namespace is gone.

    OverlayFS leaves its nested work directory mode 000. Upper directories are
    deliberately retained for forensics. Never follow symlinks while chmodding.
    """

    def accessible(path: Path) -> None:
        if path.is_symlink():
            return
        path.chmod(path.stat().st_mode | 0o700)
        for child in path.iterdir():
            if child.is_dir() and not child.is_symlink():
                accessible(child)

    results = []
    for index, spec in enumerate(mounts):
        if spec["kind"] != "overlay":
            continue
        work = artifact_path / "overlay" / str(index) / "work"
        if not work.exists():
            continue
        item = {"path": str(work)}
        try:
            if work.is_symlink():
                raise ValueError("Owned overlay work directory unexpectedly became a symlink")
            accessible(work)
            shutil.rmtree(work)
            item["state"] = "removed"
        except Exception as error:
            item.update(state="failed", error=f"{type(error).__name__}: {error}")
        results.append(item)
    return results


def unshare(flags: int) -> None:
    if _libc.unshare(ctypes.c_int(flags)) != 0:
        raise OSError(ctypes.get_errno(), "unshare")


def mount(source: str | None, target: str, kind: str | None, flags: int = 0, data: str | None = None) -> None:
    def encoded(value: str | None) -> bytes | None:
        return value.encode() if value is not None else None

    if _libc.mount(encoded(source), encoded(target), encoded(kind), ctypes.c_ulong(flags), encoded(data)) != 0:
        raise OSError(ctypes.get_errno(), f"mount {target}")


def enter_namespaces() -> None:
    uid, gid = os.getuid(), os.getgid()
    unshare(CLONE_NEWUSER)
    Path("/proc/self/setgroups").write_text("deny")
    Path("/proc/self/uid_map").write_text(f"{uid} {uid} 1\n")
    Path("/proc/self/gid_map").write_text(f"{gid} {gid} 1\n")
    unshare(CLONE_NEWNS | CLONE_NEWPID)
    mount(None, "/", None, MS_REC | MS_PRIVATE)


def identity(pid: int) -> dict:
    """Read an identity stable across PID reuse within this boot."""
    stat = Path(f"/proc/{pid}/stat").read_text()
    return {
        "pid": pid,
        "starttime": int(stat[stat.rindex(")") + 2 :].split()[19]),
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    }


def alive(expected: dict | None) -> bool:
    if not expected:
        return False
    try:
        stat = Path(f"/proc/{expected['pid']}/stat").read_text()
        return stat[stat.rindex(")") + 2 :].split()[0] != "Z" and identity(expected["pid"]) == expected
    except (FileNotFoundError, ProcessLookupError):
        return False


def signal_verified(expected: dict, sig: int = signal.SIGKILL) -> bool:
    """Pin a process with a pidfd, then verify identity before signalling it."""
    try:
        # Some standalone CPython builds omit these wrappers despite a modern
        # host kernel/libc. Use libc without falling back to racy numeric kills.
        if hasattr(os, "pidfd_open"):
            fd = os.pidfd_open(expected["pid"])
        else:
            fd = _libc.pidfd_open(ctypes.c_int(expected["pid"]), ctypes.c_uint(0))
            if fd < 0:
                raise OSError(ctypes.get_errno(), "pidfd_open")
    except ProcessLookupError:
        return False
    try:
        if not alive(expected):
            return False
        if hasattr(signal, "pidfd_send_signal"):
            signal.pidfd_send_signal(fd, sig)
        elif _libc.pidfd_send_signal(ctypes.c_int(fd), ctypes.c_int(sig), None, ctypes.c_uint(0)) != 0:
            raise OSError(ctypes.get_errno(), "pidfd_send_signal")
        return True
    except ProcessLookupError:
        return False
    finally:
        os.close(fd)
