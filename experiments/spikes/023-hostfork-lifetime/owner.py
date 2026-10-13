"""A disposable application that owns one environment for failure injection."""

import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path

from hostfork_spike import Environment, EnvironmentSpec, Export, Mount
from hostfork_spike.linux import signal_verified

HERE = Path(__file__).resolve().parent


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--retain", action="store_true")
    parser.add_argument("--freeze-supervisor", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    source = root / "source"
    source.mkdir(parents=True, exist_ok=True)
    (source / "baseline.txt").write_text("host original\n")
    environment = await Environment.create(
        EnvironmentSpec(
            mounts=[Mount("overlay", str(source))],
            deadline_seconds=1.2,
            retain_on_owner_exit=args.retain,
            exports=[Export(str(source), "workspace")],
        ),
        artifact_root=root / "environments",
    )
    await environment.spawn([sys.executable, str(HERE / "workload.py"), "tree", str(source)])
    state = await environment.status()
    (root / "owner.json").write_text(json.dumps({"path": str(environment.path), "state": state}, indent=2))
    if args.freeze_supervisor:
        await asyncio.sleep(0.15)
        signal_verified(state["supervisor_identity"], signal.SIGSTOP)
        print("supervisor frozen; external deadline must clean up", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
