"""Measure raw util-linux namespace startup as a control, not a reusable runtime."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import time
from pathlib import Path

from metrics import baseline, cpu_usage, distribution, process_metrics, process_table


async def measure(count: int, namespaced: bool) -> dict:
    """Compare a sleeping command with the minimal unshare wrapper and command."""
    commands: list[asyncio.subprocess.Process] = []
    starts: list[float] = []
    stops: list[float] = []
    before = baseline()
    cpu_before = cpu_usage()

    async def launch() -> None:
        started = time.perf_counter()
        argv = ["/bin/sh", "-c", "printf 'ready\\n'; exec /bin/sleep 90"]
        if namespaced:
            argv = [
                shutil.which("unshare"),
                "--user",
                "--map-current-user",
                "--mount",
                "--pid",
                "--fork",
                "--kill-child=KILL",
                "--mount-proc",
                "--propagation",
                "private",
                "--",
                *argv,
            ]
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        commands.append(process)
        line = await asyncio.wait_for(process.stdout.readline(), 10)
        if line != b"ready\n":
            raise RuntimeError((await process.stderr.read()).decode())
        starts.append((time.perf_counter() - started) * 1000)

    async def stop(process: asyncio.subprocess.Process) -> None:
        started = time.perf_counter()
        if process.returncode is None:
            process.kill()
        await asyncio.wait_for(process.communicate(), 10)
        stops.append((time.perf_counter() - started) * 1000)

    launched = time.perf_counter()
    try:
        outcomes = await asyncio.gather(*(launch() for _ in range(count)), return_exceptions=True)
        failures = [repr(outcome) for outcome in outcomes if isinstance(outcome, BaseException)]
        if failures:
            raise RuntimeError(f"Control commands failed: {failures}")
        start_seconds = time.perf_counter() - launched
        footprint = process_metrics([process.pid for process in commands])
        identities = {row["pid"]: row["starttime"] for row in footprint["rows"]}
    finally:
        stopping = time.perf_counter()
        await asyncio.gather(*(stop(process) for process in commands))
        stop_seconds = time.perf_counter() - stopping
    for _ in range(40):
        table = process_table()
        survivors = {
            pid: table[pid]
            for pid, starttime in identities.items()
            if pid in table and table[pid]["starttime"] == starttime
        }
        if not survivors:
            break
        await asyncio.sleep(0.05)
    cpu_after = cpu_usage()
    after = baseline()
    return {
        "kind": "unshare" if namespaced else "plain_subprocess",
        "concurrency": count,
        "start": distribution(starts),
        "stop": distribution(stops),
        "start_seconds": start_seconds,
        "stop_seconds": stop_seconds,
        "starts_per_second": count / start_seconds,
        "footprint": footprint,
        "cpu": {key: cpu_after[key] - value for key, value in cpu_before.items()},
        "baseline_before": before,
        "baseline_after": after,
        "survivors": survivors,
        "baseline_recovered": before == after and not survivors,
    }


async def main(args: argparse.Namespace) -> int:
    args.artifacts.mkdir(parents=True, exist_ok=True)
    output = args.artifacts / f"primitive-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.json"
    results = []
    for namespaced in (False, True):
        for count in args.concurrency:
            for round_number in range(args.rounds):
                result = await measure(count, namespaced)
                result["round"] = round_number + 1
                results.append(result)
                summary = dict(result)
                summary["footprint"] = {key: value for key, value in result["footprint"].items() if key != "rows"}
                print(json.dumps(summary, sort_keys=True), flush=True)
                output.write_text(json.dumps(results, indent=2) + "\n")
    print(f"Results: {output}", flush=True)
    return 0 if all(result["baseline_recovered"] for result in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--concurrency", nargs="+", type=int, default=[1, 10, 100])
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/022-hostfork-compatibility"))
    args = parser.parse_args()
    if not shutil.which("unshare"):
        parser.error("util-linux unshare is required")
    if args.rounds < 1 or min(args.concurrency) < 1:
        parser.error("rounds and concurrency must be positive")
    raise SystemExit(asyncio.run(main(args)))
