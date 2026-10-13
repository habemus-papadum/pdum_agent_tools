"""Linux primitives shared with the fresh, standard-library-only helper."""

import ctypes
import json
import os
import signal
import tempfile
from pathlib import Path

CLONE_NEWUSER = 0x10000000
CLONE_NEWNS = 0x00020000
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18
MS_REMOUNT = 32
MS_RDONLY = 1


def _libc():
    return ctypes.CDLL(None, use_errno=True)


def identity(pid: int) -> dict:
    """Return a boot-qualified process identity."""
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


def pidfd(expected: dict) -> int:
    libc = _libc()
    fd = libc.pidfd_open(ctypes.c_int(expected["pid"]), ctypes.c_uint(0))
    if fd < 0:
        raise OSError(ctypes.get_errno(), "pidfd_open")
    if not alive(expected):
        os.close(fd)
        raise ProcessLookupError("Process identity no longer exists")
    return fd


def signal_identity(expected: dict | None, sig: int = signal.SIGKILL) -> bool:
    if not expected:
        return False
    try:
        fd = pidfd(expected)
    except ProcessLookupError:
        return False
    try:
        if _libc().pidfd_send_signal(ctypes.c_int(fd), ctypes.c_int(sig), None, ctypes.c_uint(0)) != 0:
            code = ctypes.get_errno()
            if code == 3:
                return False
            raise OSError(code, "pidfd_send_signal")
        return True
    finally:
        os.close(fd)


def membership(pid: int) -> str:
    return next(x[3:] for x in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if x.startswith("0::"))


def unshare(flags: int) -> None:
    if _libc().unshare(ctypes.c_int(flags)) != 0:
        raise OSError(ctypes.get_errno(), "unshare")


def setns(fd: int, flags: int) -> None:
    if _libc().setns(ctypes.c_int(fd), ctypes.c_int(flags)) != 0:
        raise OSError(ctypes.get_errno(), "setns(pidfd)")


def mount(source: str | None, target: str, kind: str | None, flags: int = 0, data: str | None = None) -> None:
    def encoded(value):
        return value.encode() if value is not None else None

    if _libc().mount(encoded(source), encoded(target), encoded(kind), ctypes.c_ulong(flags), encoded(data)) != 0:
        raise OSError(ctypes.get_errno(), f"mount {target}")


def atomic_json(path: Path, value: dict) -> None:
    """Durably replace one journal without sharing temporary filenames."""
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def cgroup_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Invalid cgroup path")
    return Path("/sys/fs/cgroup") / str(path).lstrip("/")


def populated(path: Path) -> bool:
    try:
        return "populated 1" in (path / "cgroup.events").read_text()
    except FileNotFoundError:
        return False


def setup_timer(deadline: float):
    """Arm a kernel SIGKILL timer for a pre-exec helper, including while stopped.

    POSIX timers are removed by exec. A helper never runs workload code while
    relying on this timer: the independently armed scope must own it first.
    """

    class Event(ctypes.Structure):
        _fields_ = [
            ("value", ctypes.c_void_p),
            ("signo", ctypes.c_int),
            ("notify", ctypes.c_int),
            ("padding", ctypes.c_char * (64 - ctypes.sizeof(ctypes.c_void_p) - 8)),
        ]

    class Timespec(ctypes.Structure):
        _fields_ = [("seconds", ctypes.c_long), ("nanoseconds", ctypes.c_long)]

    class Itimerspec(ctypes.Structure):
        _fields_ = [("interval", Timespec), ("value", Timespec)]

    event = Event(None, signal.SIGKILL, 0)
    timer = ctypes.c_void_p()
    libc = _libc()
    if libc.timer_create(1, ctypes.byref(event), ctypes.byref(timer)):
        raise OSError(ctypes.get_errno(), "timer_create")
    value = Itimerspec(Timespec(0, 0), Timespec(int(deadline), int(deadline % 1 * 1_000_000_000)))
    if libc.timer_settime(timer, 1, ctypes.byref(value), None):
        libc.timer_delete(timer)
        raise OSError(ctypes.get_errno(), "timer_settime")
    return timer


def cancel_timer(timer) -> None:
    if _libc().timer_delete(timer):
        raise OSError(ctypes.get_errno(), "timer_delete")


def group_identity(path: Path) -> dict:
    st = path.stat()
    return {"device": st.st_dev, "inode": st.st_ino}


def group_matches(path: Path, expected: dict | None) -> bool:
    try:
        return expected is not None and group_identity(path) == expected
    except FileNotFoundError:
        return False
