"""Host compatibility and concurrent-environment measurements using Spike 020."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from metrics import baseline, cpu_usage, distribution, process_metrics, process_table, storage_usage
from services import HostServices

RUNTIME_SOURCE = Path(__file__).resolve().parents[1] / "020-hostfork-runtime" / "python" / "src"
sys.path.insert(0, str(RUNTIME_SOURCE))

from hostfork_spike.runtime import Environment, EnvironmentSpec, Mount  # noqa: E402


async def compatibility(artifacts: Path) -> dict:
    """Exercise actual host services and installed tools through a private view."""
    with tempfile.TemporaryDirectory(prefix="hf022-") as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        (project / "record.txt").write_text("host-original\n")
        (project / "deleted.txt").write_text("host-deletion-survives\n")
        (project / "nested").mkdir()
        (project / "restored-services").mkdir()
        (project / "nested" / "value.txt").write_text("host-nested-original\n")
        protected = root / "protected"
        protected.mkdir()
        (protected / "record.txt").write_text("protected-original\n")
        (project / "alias.txt").symlink_to(protected / "record.txt")
        nested = root / "nested-source"
        nested.mkdir()
        (nested / "value.txt").write_text("explicit-nested-bind\n")
        recreated_fifo = root / "recreated.fifo"
        os.mkfifo(recreated_fifo)
        before = baseline()
        async with HostServices(root / "services") as services, HostServices(project / "services") as lower_services:
            config = {
                **services.configuration(),
                "project": str(project),
                "protected": str(protected / "record.txt"),
                "lower_unix_path": str(lower_services.unix_path),
                "lower_fifo_path": str(lower_services.fifo_path),
                "recreated_fifo_path": str(recreated_fifo),
                "restored_unix_path": str(project / "restored-services" / "host.sock"),
                "restored_fifo_path": str(project / "restored-services" / "host.fifo"),
            }
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config))
            spec = EnvironmentSpec(
                mounts=[
                    Mount(kind="overlay", target=str(project)),
                    Mount(kind="read_only", target=str(protected)),
                    Mount(kind="bind", source=str(nested), target=str(project / "nested")),
                    Mount(kind="bind", source=str(services.directory), target=str(project / "restored-services")),
                ],
                deadline_seconds=30,
            )
            environment = await Environment.create(spec, artifact_root=artifacts)
            try:
                result = await environment.run(
                    [sys.executable, str(Path(__file__).with_name("inside.py")), str(config_path)],
                    cwd=str(project),
                )
                if result["returncode"] != 0:
                    raise RuntimeError(f"inside compatibility probe failed: {result}")
                inside = json.loads(Path(result["stdout_path"]).read_text())
                fifo = services.fifo_message()
                lower_fifo = lower_services.fifo_message()
                running = await environment.status()
            finally:
                await environment.close()
            source_preserved = (
                (project / "record.txt").read_text() == "host-original\n"
                and (project / "deleted.txt").read_text() == "host-deletion-survives\n"
                and not (project / "new.txt").exists()
                and (protected / "record.txt").read_text() == "protected-original\n"
                and (project / "nested" / "value.txt").read_text() == "host-nested-original\n"
            )
            checks = {
                "private_write": inside["private_content"] == "private-write\n",
                "unix_host_view": inside["unix_service"].get("content") == "host-original\n",
                "tcp_host_view": inside["tcp_service"].get("content") == "host-original\n",
                "fifo_shared_and_restored": fifo == "fifo-from-private-view\nfifo-via-restored-bind\n",
                "unix_restored_bind": inside["restored_unix_service"].get("content") == "host-original\n",
                "fifo_restored_bind": inside["restored_fifo"]["written"],
                "source_preserved": source_preserved,
                "read_only_write_blocked": inside["protected_write"]["blocked"],
                "nested_bind": inside["nested_mount_value"] == "explicit-nested-bind\n",
                "absolute_symlink": inside["symlink_value"] == "protected-original\n",
                "bash_and_cwd": inside["bash_output"] == "bash:42:private-write",
                "proc_consistent": inside["pid"] == inside["proc_self_pid"],
                "dev_urandom": inside["dev_random_bytes"] == 16,
                "recreated_fifo_lacks_reader": inside["recreated_fifo"]["written"] is False,
            }
        after = baseline()
        checks["caller_resources_recovered"] = before == after
        return {
            "passed": all(checks.values()),
            "checks": checks,
            "inside": inside,
            "overlay_lower_fifo_received": lower_fifo,
            "host_uid": os.getuid(),
            "host_gid": os.getgid(),
            "host_pid": os.getpid(),
            "environment_path": str(environment.path),
            "running_status": running,
            "before": before,
            "after": after,
        }


async def benchmark_batch(count: int, artifacts: Path, source: Path, backend: str, idle_seconds: float = 0) -> dict:
    """Measure a simultaneous batch, retaining every lifecycle record for inspection."""
    environments: list[Environment] = []
    starts: list[float] = []
    launches: list[float] = []
    stops: list[float] = []
    before = baseline()
    cpu_before = cpu_usage()

    async def start_one() -> None:
        started = time.perf_counter()
        mounts = [Mount(kind="overlay", target=str(source))] if backend == "overlay" else []
        environment = await Environment.create(
            EnvironmentSpec(mounts=mounts, deadline_seconds=120), artifact_root=artifacts
        )
        environments.append(environment)
        starts.append((time.perf_counter() - started) * 1000)
        await environment.spawn(["/bin/sleep", "90"], cwd=str(source))
        launches.append((time.perf_counter() - started) * 1000)

    async def stop_one(environment: Environment) -> None:
        started = time.perf_counter()
        await environment.close(reason="benchmark_complete")
        stops.append((time.perf_counter() - started) * 1000)

    batch_start = time.perf_counter()
    errors: list[str] = []
    roots: list[int] = []
    identities: dict[int, int] = {}
    footprint = {}
    idle_measurement = None
    try:
        outcomes = await asyncio.gather(*(start_one() for _ in range(count)), return_exceptions=True)
        errors.extend(repr(outcome) for outcome in outcomes if isinstance(outcome, BaseException))
        start_seconds = time.perf_counter() - batch_start
        statuses = await asyncio.gather(*(environment.status() for environment in environments))
        roots = [status["supervisor_pid"] for status in statuses]
        footprint = process_metrics(roots)
        identities = {row["pid"]: row["starttime"] for row in footprint["rows"]}
        if idle_seconds:
            idle_started = time.perf_counter()
            await asyncio.sleep(idle_seconds)
            idle_footprint = process_metrics(roots)
            wall_seconds = time.perf_counter() - idle_started
            cpu_seconds = idle_footprint["cpu_seconds"] - footprint["cpu_seconds"]
            idle_measurement = {
                "wall_seconds": wall_seconds,
                "owned_process_cpu_seconds": cpu_seconds,
                "equivalent_cpu_cores": cpu_seconds / wall_seconds,
                "cpu_percent_one_core_per_environment": cpu_seconds / wall_seconds / count * 100,
                "process_count_stable": idle_footprint["process_count"] == footprint["process_count"],
            }
    finally:
        stop_start = time.perf_counter()
        outcomes = await asyncio.gather(
            *(stop_one(environment) for environment in environments), return_exceptions=True
        )
        errors.extend(repr(outcome) for outcome in outcomes if isinstance(outcome, BaseException))
        stop_seconds = time.perf_counter() - stop_start
    # Poll only for already-exiting owned identities; never kill an unrelated PID.
    survivors = {}
    for _ in range(40):
        table = process_table()
        survivors = {
            pid: table[pid]
            for pid, started in identities.items()
            if pid in table and table[pid]["starttime"] == started
        }
        if not survivors:
            break
        await asyncio.sleep(0.05)
    after = baseline()
    cpu_after = cpu_usage()
    return {
        "concurrency": count,
        "backend": backend,
        "created": len(environments),
        "errors": errors,
        "environment_start": distribution(starts) if starts else None,
        "environment_and_command_start": distribution(launches) if launches else None,
        "stop": distribution(stops) if stops else None,
        "batch_start_seconds": start_seconds,
        "batch_stop_seconds": stop_seconds,
        "environment_starts_per_second": len(launches) / start_seconds,
        "environment_stops_per_second": len(stops) / stop_seconds,
        "footprint": footprint,
        "idle": idle_measurement,
        "cpu": {key: cpu_after[key] - value for key, value in cpu_before.items()},
        "retained_storage": storage_usage([environment.path for environment in environments]),
        "survivors": survivors,
        "baseline_before": before,
        "baseline_after": after,
        "baseline_recovered": before == after and not survivors,
        "environment_paths": [str(environment.path) for environment in environments],
    }


async def main(args: argparse.Namespace) -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    artifacts = args.artifacts.resolve() / f"run-{stamp}-{os.getpid()}"
    artifacts.mkdir(parents=True)
    result: dict = {
        "date_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": platform.python_version(),
        "kernel": platform.release(),
        "cpu_count": os.cpu_count(),
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "runtime_source_sha256": {
            name: hashlib.sha256((RUNTIME_SOURCE / "hostfork_spike" / name).read_bytes()).hexdigest()
            for name in ("runtime.py", "helper.py", "linux.py")
        },
        "artifacts": str(artifacts),
        "measurements": [],
    }
    try:
        if args.mode in ("compatibility", "all"):
            result["compatibility"] = await compatibility(artifacts)
            print(json.dumps({"compatibility": result["compatibility"]["checks"]}), flush=True)
        if args.mode in ("benchmark", "all"):
            with tempfile.TemporaryDirectory(prefix="hf022-bench-") as temporary:
                source = Path(temporary)
                for index in range(100):
                    (source / f"input-{index:03d}.txt").write_text("read-only-input\n" * 16)
                for backend in args.backends.split(","):
                    for count in (int(value) for value in args.concurrency.split(",")):
                        for round_number in range(args.rounds):
                            measurement = await benchmark_batch(count, artifacts, source, backend, args.idle_seconds)
                            measurement["round"] = round_number + 1
                            result["measurements"].append(measurement)
                            summary = {
                                key: value
                                for key, value in measurement.items()
                                if key not in ("footprint", "environment_paths")
                            }
                            summary["footprint"] = {
                                key: value for key, value in measurement["footprint"].items() if key != "rows"
                            }
                            print(json.dumps(summary, sort_keys=True), flush=True)
                            (artifacts / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        result["passed"] = result.get("compatibility", {}).get("passed", True) and all(
            not batch["errors"] and batch["baseline_recovered"] for batch in result["measurements"]
        )
    except Exception as exc:
        result["error"] = repr(exc)
        result["passed"] = False
        raise
    finally:
        (artifacts / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        print(f"Results: {artifacts / 'results.json'}", flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("compatibility", "benchmark", "all"), nargs="?", default="all")
    parser.add_argument("--concurrency", default="1,10,100")
    parser.add_argument("--backends", default="host,overlay", help="host,overlay (comma separated)")
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--idle-seconds", type=float, default=0, help="Optional idle CPU sampling window")
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/022-hostfork-compatibility"))
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("rounds must be positive")
    if args.idle_seconds < 0:
        parser.error("idle-seconds cannot be negative")
    try:
        if min(int(value) for value in args.concurrency.split(",")) < 1:
            raise ValueError
    except ValueError:
        parser.error("concurrency must contain positive integers separated by commas")
    if any(backend not in ("host", "overlay") for backend in args.backends.split(",")):
        parser.error("backends must contain host or overlay separated by commas")
    raise SystemExit(asyncio.run(main(args)))
