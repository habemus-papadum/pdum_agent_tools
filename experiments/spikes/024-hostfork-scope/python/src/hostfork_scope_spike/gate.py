"""Fresh exec helper: run no workload until scope registration is confirmed."""

import os
import sys
from pathlib import Path


def main() -> None:
    descriptor, cwd, marker, *argv = sys.argv[1:]
    descriptor = int(descriptor)
    try:
        release = os.read(descriptor, 1)
    finally:
        os.close(descriptor)
    if release != b"G":
        raise SystemExit(125)
    os.chdir(cwd)
    Path(marker).write_text("workload released\n")
    os.execvpe(argv[0], argv, os.environ)


if __name__ == "__main__":
    main()
