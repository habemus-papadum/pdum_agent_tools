"""Small real workloads for cgroup failure/CPU experiments; never target other processes."""

import json
import os
import signal
import sys
import time
from pathlib import Path

from hostfork_spike.linux import identity


def main() -> None:
    mode, destination = sys.argv[1], Path(sys.argv[2])
    destination.mkdir(parents=True, exist_ok=True)
    if mode == "cpu":
        start, cpu_start = time.monotonic(), time.process_time()
        value = 1
        while time.monotonic() - start < 1.6:
            value = (value * 17 + 7) % 999983
        print(
            json.dumps(
                {
                    "wall_seconds": time.monotonic() - start,
                    "cpu_seconds": time.process_time() - cpu_start,
                    "value": value,
                }
            ),
            flush=True,
        )
    elif mode == "oom":
        blocks = []
        while True:
            blocks.append(bytearray(2 * 1024 * 1024))
            print(f"allocated_mib={2 * len(blocks)}", flush=True)
            time.sleep(0.015)
    elif mode == "tree":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = os.fork()
        if child == 0:
            os.setsid()
        role = "descendant" if child == 0 else "parent"
        (destination / f"{role}.json").write_text(json.dumps(identity(os.getpid())))
        with (destination / f"{role}.partial").open("a", buffering=1) as stream:
            while True:
                stream.write(f"{time.time()} still alive\n")
                print(role, flush=True)
                time.sleep(0.05)
    else:
        raise ValueError(mode)


if __name__ == "__main__":
    main()
