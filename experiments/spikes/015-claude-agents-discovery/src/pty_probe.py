"""Bound a real local terminal attachment without submitting a model prompt."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from pathlib import Path


def main() -> None:
    """Attach, capture terminal output, send the native detach key, then exit."""
    case = json.loads(Path(sys.argv[1]).read_text())
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(case["cwd"])
        args = case.get("args", ["attach", case.get("id", "")])
        os.execve(case["binary"], [case["binary"], *args], case["env"])
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    chunks = []
    started = time.monotonic()
    sent_detach = False
    status = None
    try:
        while time.monotonic() - started < 8:
            elapsed = time.monotonic() - started
            if elapsed >= 5 and not sent_detach:
                os.write(master, case.get("exitKeys", "\x1a").encode())
                sent_detach = True
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                chunks.append(chunk)
            reaped, raw_status = os.waitpid(pid, os.WNOHANG)
            if reaped:
                status = os.waitstatus_to_exitcode(raw_status)
                break
    finally:
        if status is None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(20):
                reaped, raw_status = os.waitpid(pid, os.WNOHANG)
                if reaped:
                    status = os.waitstatus_to_exitcode(raw_status)
                    break
                time.sleep(0.05)
            if status is None:
                os.kill(pid, signal.SIGKILL)
                _, raw_status = os.waitpid(pid, 0)
                status = os.waitstatus_to_exitcode(raw_status)
        os.close(master)
    Path(case["output"]).write_bytes(b"".join(chunks))
    print(json.dumps({"pid": pid, "exitCode": status, "bytes": sum(map(len, chunks)), "sentDetach": sent_detach}))


if __name__ == "__main__":
    main()
