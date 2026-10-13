"""Report actual Hostfork prerequisites without silently preparing the host.

Run with ``uv run --frozen --all-packages python scripts/check_hostfork_capabilities.py``.
Use ``--probe --require-linux`` on a deliberately prepared Linux integration host.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from pdum.hostfork.doctor import doctor


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="Storage path to inspect/probe (default: temporary directory)")
    parser.add_argument("--probe", action="store_true", help="Create disposable namespaces, mounts and a user scope")
    parser.add_argument("--require-linux", action="store_true", help="Fail unless all probed Linux prerequisites work")
    parser.add_argument("--output", type=Path, help="Also write JSON to this explicit path")
    arguments = parser.parse_args()
    if arguments.require_linux and not arguments.probe:
        parser.error("--require-linux requires --probe; configuration hints cannot qualify the host")
    result = await doctor(arguments.root, probe=arguments.probe)
    capabilities = result["capabilities"]
    checks = {
        "user_mount": capabilities["namespace"].get("user_mount") is True,
        "overlay": capabilities["namespace"].get("overlay") is True,
        "read_only_bind": capabilities["namespace"].get("read_only_bind") is True,
        "recursive_read_only": capabilities["namespace"].get("recursive_read_only") is True,
        "pidfd_registration": capabilities["systemd"].get("pidfd_registration") == "observed",
        "delegation": capabilities["cgroup"].get("delegated_scope") == "observed",
    }
    result["required_checks"] = checks if arguments.require_linux else None
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(rendered)
    print(rendered, end="")
    return int(arguments.require_linux and not all(checks.values()))


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
