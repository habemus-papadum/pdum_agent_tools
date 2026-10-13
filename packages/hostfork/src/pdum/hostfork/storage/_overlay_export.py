"""Fresh-interpreter mount helper; used only inside unshare's private namespace."""

import ctypes
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


def main() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if os.getppid() != int(sys.argv[3]):
        raise SystemExit(125)
    record = json.loads(Path(sys.argv[1]).read_text())
    scratch = Path(sys.argv[2])
    merged = scratch / "merged"
    merged.mkdir()
    for field in ("source", "upper", "work"):
        if any(character in record[field] for character in ":,\\\n"):
            raise ValueError("Unsupported overlay option delimiter in path")
    options = f"lowerdir={record['source']},upperdir={record['upper']},workdir={record['work']},userxattr,ro"
    prefix = [sys.executable, "-I", str(Path(__file__).with_name("_owned_exec.py")), str(os.getpid())]
    subprocess.run([*prefix, "mount", "-t", "overlay", "overlay", "-o", options, str(merged)], check=True)
    try:
        subprocess.run([*prefix, "cp", "-a", "--reflink=never", str(merged) + "/.", str(scratch / "tree")], check=True)
    finally:
        subprocess.run([*prefix, "umount", str(merged)], check=True)
    merged.rmdir()


if __name__ == "__main__":
    main()
