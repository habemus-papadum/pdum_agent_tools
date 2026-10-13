"""Exercise the built wheel's actual files using root-workspace dependencies."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import zipfile
from pathlib import Path


async def check(root: Path) -> dict:
    import pdum.hostfork
    from pdum.hostfork import EnvironmentSpec, Hostfork, Lifetime

    module = Path(pdum.hostfork.__file__).resolve()
    assert module.is_relative_to(root / "wheel"), module
    assert module.with_name("py.typed").exists()
    host = Hostfork(root / "state")
    async with await host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10))) as environment:
        command = await environment.spawn(["/bin/echo", "wheel-runtime"], stdout=asyncio.subprocess.PIPE)
        output, _ = await command.communicate()
        assert output == b"wheel-runtime\n"
        assert (await command.wait()).returncode == 0
    result = await host.gc(force=True)
    assert result[0]["state"] == "purged", result
    return {"module": str(module), "native_pid": command.pid, "cleanup": result[0]["state"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="hostfork-wheel-") as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(args.wheel) as wheel:
            wheel.extractall(root / "wheel")
        sys.path.insert(0, str(root / "wheel"))
        print(json.dumps(asyncio.run(check(root))))


if __name__ == "__main__":
    main()
