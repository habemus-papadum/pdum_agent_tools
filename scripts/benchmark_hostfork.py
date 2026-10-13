"""Bounded real-runtime benchmark; emits JSON and retains only the final report.

Run from the root workspace with ``uv run python scripts/benchmark_hostfork.py``.
The temporary registry is owned by this invocation; its environments are stopped
in finally before temporary state is removed. This does not format filesystems.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import time
from pathlib import Path

from pdum.hostfork import EnvironmentSpec, Hostfork, Lifetime, Retention


def summary(values):
    ordered = sorted(values)
    return {
        "mean_seconds": statistics.mean(values),
        "p50_seconds": statistics.median(values),
        "p95_seconds": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
    }


async def measure(count: int, rounds: int) -> dict:
    results = []
    directory = tempfile.mkdtemp(prefix="hostfork-benchmark-")
    try:
        host = Hostfork(Path(directory) / "state")
        environments = []
        try:
            for _ in range(rounds):
                started = time.perf_counter()

                async def create():
                    before = time.perf_counter()
                    environment = await host.create(
                        EnvironmentSpec(lifetime=Lifetime(max_runtime=120), retention=Retention(0, 0))
                    )
                    environments.append(environment)
                    return environment, time.perf_counter() - before

                batch = await asyncio.gather(*(create() for _ in range(count)), return_exceptions=True)
                failures = [item for item in batch if isinstance(item, BaseException)]
                if failures:
                    raise ExceptionGroup("Concurrent creation failed", failures)
                launch = []

                async def command(environment):
                    before = time.perf_counter()
                    child = await environment.spawn(["/bin/true"])
                    assert (await child.wait()).returncode == 0
                    await child.wait_tree()
                    launch.append(time.perf_counter() - before)

                await asyncio.gather(*(command(environment) for environment, _ in batch))
                alive = await asyncio.gather(*(environment.status() for environment, _ in batch))
                keeper_rss = 0
                for state in alive:
                    pid = state["runtime"]["keeper_identity"]["pid"]
                    try:
                        values = dict(
                            line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines()
                        )
                        keeper_rss += int(values["VmRSS"].split()[0]) * 1024
                    except (OSError, KeyError):
                        pass
                before = time.perf_counter()
                stopped = await asyncio.gather(*(environment.stop() for environment, _ in batch))
                stop_seconds = time.perf_counter() - before
                assert all(record["state"] == "stopped" for record in stopped), stopped
                collected = await host.gc()
                assert all(not record["pending"] for record in collected), collected
                wall = time.perf_counter() - started
                results.append(
                    {
                        "create": summary([elapsed for _, elapsed in batch]),
                        "command": summary(launch),
                        "batch_stop_seconds": stop_seconds,
                        "wall_seconds": wall,
                        "completed_environments_per_second": count / wall,
                        "keeper_rss_bytes_sum": keeper_rss,
                        "caller_fds": len(os.listdir("/proc/self/fd")),
                    }
                )
        finally:
            for environment in environments:
                try:
                    await environment.stop("benchmark_cleanup")
                except Exception as error:
                    print(f"cleanup pending {environment.id}: {error}")
    finally:
        recovery = await host.reap()
        collected = await host.gc(force=True)
        if all(record["state"] == "purged" for record in await host.list()):
            import shutil

            shutil.rmtree(directory)
        else:
            print(json.dumps({"retained_recovery_path": directory, "recovery": recovery, "gc": collected}), flush=True)
    return {"concurrency": count, "rounds": results}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts", default="1,10,100,200")
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--output", type=Path, default=Path("artifacts/hostfork-benchmark.json"))
    args = parser.parse_args()
    report = {"time": time.time(), "platform": os.uname().release, "samples": []}
    for count in map(int, args.counts.split(",")):
        report["samples"].append(await measure(count, args.rounds))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["samples"][-1]), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
