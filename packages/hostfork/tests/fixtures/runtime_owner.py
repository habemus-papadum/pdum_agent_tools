"""Real owner process used to qualify abrupt death and frozen-owner recovery."""

import asyncio
import json
import os
import sys
from pathlib import Path

from pdum.hostfork.backends.linux import LinuxRuntime

if wrapper := os.environ.get("PDUM_HOSTFORK_TEST_HELPER_WRAPPER"):
    from pdum.hostfork.backends.linux import runtime as implementation

    implementation._HELPER = Path(wrapper)


async def main():
    state, identifier, mode, lifetime = sys.argv[1:]
    runtime = await LinuxRuntime.create(
        identifier,
        Path(state),
        [],
        max_runtime=float(lifetime),
        grace_seconds=0.1,
        owner_exit="retain" if mode == "retain_exit" else "stop",
    )
    if mode in ("detach_exit", "retain_exit"):
        if mode == "detach_exit":
            await runtime.detach()
        print(json.dumps({"ready": True, "deadline": runtime.record["deadline_monotonic"]}), flush=True)
        return
    if mode == "gate":
        original = runtime.manager.start

        async def blocked(unit, *args, **kwargs):
            result = await original(unit, *args, **kwargs)
            print(json.dumps({"ready": True}), flush=True)
            await asyncio.Event().wait()
            return result

        runtime.manager.start = blocked
    command = await runtime.spawn(
        ["/bin/sleep", "60"],
        command_id="work",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    if mode == "detach":
        await runtime.detach()
    print(json.dumps({"ready": True, "identity": command.identity}), flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
