"""Exec a known storage utility with kernel-enforced parent-death ownership."""

import ctypes
import os
import signal
import sys


def main() -> None:
    expected_parent = int(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if os.getppid() != expected_parent:
        raise SystemExit(125)
    os.execvp(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    main()
