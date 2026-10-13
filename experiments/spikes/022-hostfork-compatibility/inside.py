"""Run real compatibility checks from inside one Hostfork environment."""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path


def request(family: socket.AddressFamily, endpoint: str | tuple[str, int], path: Path) -> dict:
    """Ask the host service to read a path using its own filesystem view."""
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(endpoint)
        client.sendall(str(path).encode() + b"\n")
        with client.makefile("rb") as stream:
            return json.loads(stream.readline())


def try_request(family: socket.AddressFamily, endpoint: str | tuple[str, int], path: Path) -> dict:
    """Record endpoint visibility without turning an expected failure into a hang."""
    try:
        return request(family, endpoint, path)
    except OSError as exc:
        return {"errno": exc.errno, "error": str(exc)}


def try_fifo(path: str, message: bytes = b"fifo-from-private-view\n") -> dict:
    """Attempt a nonblocking FIFO write so a missing peer is observable."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(fd, message)
        finally:
            os.close(fd)
        return {"written": True}
    except OSError as exc:
        return {"written": False, "errno": exc.errno, "error": str(exc)}


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    project = Path(config["project"])
    record = project / "record.txt"
    record.write_text("private-write\n")
    (project / "new.txt").write_text("private-created\n")
    (project / "deleted.txt").unlink()
    fifo_fd = os.open(config["fifo_path"], os.O_WRONLY | os.O_NONBLOCK)
    try:
        os.write(fifo_fd, b"fifo-from-private-view\n")
    finally:
        os.close(fifo_fd)
    protected = Path(config["protected"])
    try:
        protected.write_text("unexpected-write\n")
        protected_write = {"blocked": False}
    except OSError as exc:
        protected_write = {"blocked": True, "errno": exc.errno, "error": str(exc)}
    shell = subprocess.run(
        ["/bin/bash", "-c", 'printf "bash:%s:%s" "$((6*7))" "$(cat record.txt)"'],
        cwd=project,
        check=True,
        capture_output=True,
        text=True,
    )
    with open("/dev/urandom", "rb") as random_source:
        random_bytes = len(random_source.read(16))
    with open("/dev/null", "wb") as null:
        null.write(b"device-write")
    result = {
        "private_content": record.read_text(),
        "unix_service": request(socket.AF_UNIX, config["unix_path"], record),
        "tcp_service": request(socket.AF_INET, ("127.0.0.1", config["tcp_port"]), record),
        "overlay_lower_unix_service": try_request(socket.AF_UNIX, config["lower_unix_path"], record),
        "overlay_lower_fifo": try_fifo(config["lower_fifo_path"]),
        "restored_unix_service": try_request(socket.AF_UNIX, config["restored_unix_path"], record),
        "restored_fifo": try_fifo(config["restored_fifo_path"], b"fifo-via-restored-bind\n"),
        "recreated_fifo": try_fifo(config["recreated_fifo_path"]),
        "protected_write": protected_write,
        "python_version": platform.python_version(),
        "python_executable": sys.executable,
        "bash_output": shell.stdout,
        "tool_paths": {name: shutil.which(name) for name in ("bash", "git", "uv")},
        "git_version": subprocess.check_output(["git", "--version"], text=True).strip(),
        "kernel": platform.release(),
        "pid": os.getpid(),
        "proc_self_pid": int(Path("/proc/self/stat").read_text().split()[0]),
        "proc_pid1_comm": Path("/proc/1/comm").read_text().strip(),
        "proc_visible_processes": len([p for p in Path("/proc").iterdir() if p.name.isdigit()]),
        "sys_online_cpus": Path("/sys/devices/system/cpu/online").read_text().strip(),
        "dev_random_bytes": random_bytes,
        "uid": os.getuid(),
        "gid": os.getgid(),
        "cwd": os.getcwd(),
        "nested_mount_value": (project / "nested" / "value.txt").read_text(),
        "symlink_value": (project / "alias.txt").read_text(),
    }
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
