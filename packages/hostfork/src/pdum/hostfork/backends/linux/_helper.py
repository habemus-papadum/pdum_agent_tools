"""Fresh exec helper. Only standard-library imports precede namespace entry."""

import json
import os
import signal
import socket
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _syscalls import (  # noqa: E402
    CLONE_NEWNS,
    CLONE_NEWUSER,
    MS_BIND,
    MS_PRIVATE,
    MS_REC,
    atomic_json,
    cancel_timer,
    identity,
    mount,
    setns,
    setup_timer,
    unshare,
)


def receive(connection: socket.socket, closed: Path, timeout: float = 15) -> bytes:
    until = time.monotonic() + timeout
    connection.settimeout(0.1)
    while time.monotonic() < until:
        if closed.exists():
            raise RuntimeError("Environment admission is closed")
        try:
            value = connection.recv(16)
        except TimeoutError:
            continue
        if value != b"G":
            raise RuntimeError("Launch gate closed before release")
        return value
    raise TimeoutError("Launch gate setup deadline expired")


def apply_mounts(specs: list[dict]) -> None:
    # Explicit shared/baseline sources refer to the original host view. Resolve
    # them all before a parent replacement can hide the source inode. Read-only
    # rules deliberately resolve against the resulting view instead.
    descriptors = []
    pinned = []
    try:
        for original in specs:
            spec = dict(original)
            keys = ("source", "upper", "work") if spec["kind"] == "overlay" else ("source",)
            if spec["kind"] != "read_only":
                for key in keys:
                    path = spec.get(key, spec["target"])
                    if spec["kind"] == "overlay" and any(char in path for char in ",:\\"):
                        raise ValueError("Overlay paths containing comma, colon or backslash are unsupported")
                    descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
                    descriptors.append(descriptor)
                    spec[key] = f"/proc/self/fd/{descriptor}"
            pinned.append(spec)
        _apply_mounts(pinned)
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def _apply_mounts(specs: list[dict]) -> None:
    for spec in specs:
        target = spec["target"]
        if not Path(target).exists():
            raise ValueError(f"Mount target must already exist: {target}")
        kind = spec["kind"]
        source = spec.get("source", target)
        if kind == "overlay":
            paths = [source, spec["upper"], spec["work"]]
            if any(any(char in str(path) for char in ",:\\") for path in paths):
                raise ValueError("Overlay paths containing comma, colon or backslash are unsupported")
            options = spec.get("options", ["userxattr"])
            data = f"lowerdir={source},upperdir={spec['upper']},workdir={spec['work']}"
            if options:
                data += "," + ",".join(options)
            mount("overlay", target, "overlay", data=data)
        elif kind in ("bind", "fresh", "read_only"):
            mount(source, target, None, MS_BIND | MS_REC)
            if kind == "read_only":
                # mount_setattr makes nested mounts read-only too; remounting only
                # the top bind is insufficient. Supported kernels are diagnosed.
                import ctypes

                class MountAttr(ctypes.Structure):
                    _fields_ = [
                        (name, ctypes.c_uint64) for name in ("attr_set", "attr_clr", "propagation", "userns_fd")
                    ]

                attributes = MountAttr(1, 0, 0, 0)
                libc = ctypes.CDLL(None, use_errno=True)
                result = libc.syscall(
                    442, -100, target.encode(), 0x8000, ctypes.byref(attributes), ctypes.sizeof(attributes)
                )
                if result:
                    raise OSError(ctypes.get_errno(), f"recursive read-only mount: {target}")
        else:
            raise ValueError(f"Unknown mount kind: {kind}")


def keeper(config: dict, connection: socket.socket, root: Path, timer) -> None:
    closed = root / "admission-closed"
    receive(connection, closed)
    config = json.loads((root / "keeper-config.json").read_text())
    cgroup = Path(config["cgroup"])
    keeper_group = cgroup / "keeper"
    keeper_group.mkdir()
    (cgroup / "commands").mkdir()
    (keeper_group / "cgroup.procs").write_text("0")
    controllers = set((cgroup / "cgroup.controllers").read_text().split()) & {"cpu", "memory", "pids"}
    if controllers:
        enabled = " ".join("+" + item for item in sorted(controllers))
        (cgroup / "cgroup.subtree_control").write_text(enabled)
        (cgroup / "commands" / "cgroup.subtree_control").write_text(enabled)
    kill_fd = os.open(cgroup / "cgroup.kill", os.O_WRONLY)
    uid, gid = os.getuid(), os.getgid()
    unshare(CLONE_NEWUSER)
    Path("/proc/self/setgroups").write_text("deny")
    Path("/proc/self/uid_map").write_text(f"{uid} {uid} 1\n")
    Path("/proc/self/gid_map").write_text(f"{gid} {gid} 1\n")
    unshare(CLONE_NEWNS)
    mount(None, "/", None, MS_PRIVATE | MS_REC)
    os.chdir("/")
    apply_mounts(config["mounts"])
    cancel_timer(timer)
    connection.send(json.dumps({"ready": True, "identity": identity(os.getpid())}).encode())
    connection.settimeout(None)
    value = connection.recv(16)
    policy = json.loads((root / "runtime.json").read_text()).get("owner_exit", config["owner_exit"])
    if value == b"D" or policy == "retain":
        connection.close()
        while True:
            signal.pause()
    # EOF, including abrupt owner death, means whole-environment stop.
    try:
        atomic_json(root / "keeper-event.json", {"reason": "owner_exit", "time": time.time()})
        closed.touch(exist_ok=True)
    except OSError:
        # Failed evidence storage must not prevent the owner-loss kill.
        pass
    os.write(kill_fd, b"1")
    raise RuntimeError("cgroup.kill unexpectedly returned to a live keeper")


def command(config: dict, connection: socket.socket, root: Path, target_fd: int, keeper_fd: int) -> None:
    closed = root / "admission-closed"
    receive(connection, closed)
    os.write(target_fd, b"0")
    os.close(target_fd)
    # Namespace FDs never exist in the outside caller. The pidfd pins identity
    # without retaining a dead keeper's mount namespace.
    setns(keeper_fd, CLONE_NEWUSER | CLONE_NEWNS)
    os.close(keeper_fd)
    os.chdir(config["cwd"])
    if closed.exists():
        raise RuntimeError("Environment stopped during namespace entry")
    connection.send(json.dumps({"ready": True}).encode())
    receive(connection, closed)
    connection.close()
    os.execvpe(config["argv"][0], config["argv"], os.environ)


def main() -> None:
    mode, filename, socket_fd, *extra = sys.argv[1:]
    path = Path(filename)
    config = json.loads(path.read_text())
    timer = setup_timer(config["setup_deadline_monotonic"])
    # Keep access to the host-side journal even when the workload view replaces
    # one of its ancestors. This descriptor is owned by the scoped helper only.
    root_fd = os.open(config["state_dir"], os.O_RDONLY | os.O_DIRECTORY)
    os.set_inheritable(root_fd, False)
    root = Path(f"/proc/self/fd/{root_fd}")
    connection = socket.socket(fileno=int(socket_fd))
    try:
        connection.send(json.dumps({"identity": identity(os.getpid())}).encode())
        if mode == "keeper":
            keeper(config, connection, root, timer)
        else:
            command(config, connection, root, int(extra[0]), int(extra[1]))
    except BaseException as error:
        try:
            connection.send(json.dumps({"error": f"{type(error).__name__}: {error}"}).encode())
        except OSError:
            pass
        if not isinstance(error, (BrokenPipeError, ConnectionResetError)):
            traceback.print_exc()
        raise SystemExit(125) from error
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    main()
