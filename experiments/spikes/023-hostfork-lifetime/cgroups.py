"""Measure external cgroup ownership using uniquely named user systemd units.

Run from experiments/: uv run --frozen python spikes/023-hostfork-lifetime/cgroups.py
No root access, persistent unit files, or changes to the launching session cgroup.
"""

import argparse
import asyncio
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

from hostfork_spike import status_at
from hostfork_spike.linux import alive

HERE = Path(__file__).resolve().parent
PROPERTIES = (
    "ActiveState",
    "SubState",
    "Result",
    "ExecMainCode",
    "ExecMainStatus",
    "CPUUsageNSec",
    "MemoryPeak",
    "MemoryMax",
    "MemorySwapMax",
    "CPUQuotaPerSecUSec",
    "RuntimeMaxUSec",
    "ControlGroup",
)


def command(*argv: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=15, check=check)


def properties(unit: str, names: tuple[str, ...] = PROPERTIES) -> dict[str, str]:
    result = command("systemctl", "--user", "show", unit, *(f"--property={name}" for name in names))
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def counters(path: Path) -> dict[str, int]:
    try:
        return {key: int(value) for key, value in (line.split() for line in path.read_text().splitlines())}
    except FileNotFoundError:
        return {}


def scenario(root: Path, name: str, mode: str, extra: list[str]) -> dict:
    destination = root / name
    destination.mkdir()
    suffix = uuid.uuid4().hex[:12]
    unit, slice_name = f"hostfork-spike-{suffix}.service", f"hostforkspike{suffix}.slice"
    unit_properties = [
        "RemainAfterExit=yes",
        "KillMode=control-group",
        "TimeoutStopSec=0.3s",
        "RuntimeMaxSec=10s",
        "MemoryAccounting=yes",
        "CPUAccounting=yes",
        "MemorySwapMax=0",
        "MemoryMax=96M",
        f"StandardOutput=append:{destination / 'stdout.log'}",
        f"StandardError=append:{destination / 'stderr.log'}",
        *extra,
    ]
    started = time.monotonic()
    sample = {}
    slice_path = None
    try:
        payload = (
            [str(HERE / "owner.py"), str(destination), "--freeze-supervisor"]
            if mode == "hostfork"
            else [str(HERE / "workload.py"), mode, str(destination)]
        )
        command(
            "systemd-run",
            "--user",
            f"--unit={unit}",
            f"--slice={slice_name}",
            *(f"--property={item}" for item in unit_properties),
            sys.executable,
            *payload,
        )
        slice_path = Path("/sys/fs/cgroup") / properties(slice_name, ("ControlGroup",))["ControlGroup"].lstrip("/")
        until = time.monotonic() + 15
        while time.monotonic() < until:
            state = properties(unit)
            sample = counters(slice_path / "memory.events") or sample
            if state["ActiveState"] == "failed" or state["SubState"] == "exited":
                break
            time.sleep(0.03)
        else:
            raise TimeoutError(f"Test unit failed to reach terminal state: {unit}")
        result = {
            "name": name,
            "unit": unit,
            "elapsed_seconds": time.monotonic() - started,
            "systemd": state,
            "memory_events": counters(slice_path / "memory.events") or sample,
            "stdout_bytes": (destination / "stdout.log").stat().st_size,
            "partial_files": [p.name for p in destination.glob("*.partial")],
        }
        identities = [json.loads(p.read_text()) for p in destination.glob("*.json") if p.name != "owner.json"]
        result["surviving_workloads"] = [item for item in identities if alive(item)]
        if name == "memory_oom":
            assert state["Result"] == "oom-kill", result
            assert result["memory_events"].get("oom_kill", 0) > 0, result
        if name == "hard_deadline":
            assert state["Result"] == "timeout", result
            assert state["ExecMainStatus"] == "9", result
            assert len(result["partial_files"]) == 2 and not result["surviving_workloads"], result
        if mode == "hostfork":
            metadata = json.loads((destination / "owner.json").read_text())
            env_path = Path(metadata["path"])
            result["runtime_status"] = asyncio.run(status_at(env_path))
            result["partial_upper_files"] = [
                str(p.relative_to(env_path)) for p in (env_path / "overlay").rglob("*.partial")
            ]
            result["final_export_present"] = (env_path / "init-final.json").exists()
            result["surviving_runtime"] = [
                metadata["state"][key]
                for key in ("supervisor_identity", "namespace_init_identity", "precursor_identity")
                if alive(metadata["state"][key])
            ]
            assert state["Result"] == "timeout" and not result["surviving_runtime"], result
            assert len(result["partial_upper_files"]) == 2, result
            assert "supervisor frozen" in (destination / "stdout.log").read_text(), result
        return result
    finally:
        command("systemctl", "--user", "stop", unit, check=False)
        command("systemctl", "--user", "reset-failed", unit, check=False)
        command("systemctl", "--user", "stop", slice_name, check=False)
        # Keep the evidence but verify the transient cgroup no longer exists.
        if slice_path is not None:
            until = time.monotonic() + 3
            while slice_path.exists() and time.monotonic() < until:
                time.sleep(0.02)
            if slice_path.exists():
                raise RuntimeError(f"Transient cgroup remained: {slice_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/hostfork-lifetime"))
    args = parser.parse_args()
    root = args.output.resolve() / ("cgroups-" + uuid.uuid4().hex[:10])
    root.mkdir(parents=True)
    results = []
    for name, mode, extra in (
        ("cpu_baseline", "cpu", []),
        ("cpu_25_percent", "cpu", ["CPUQuota=25%"]),
        ("memory_oom", "oom", []),
        ("hard_deadline", "tree", ["RuntimeMaxSec=1.5s"]),
        ("frozen_runtime_external_deadline", "hostfork", ["RuntimeMaxSec=1.8s", "MemoryMax=160M"]),
    ):
        result = scenario(root, name, mode, extra)
        result["cgroup_removed"] = True
        results.append(result)
        (root / "results.json").write_text(json.dumps({"results": results}, indent=2) + "\n")
        print(f"{name}: {result['systemd']['Result']}, {result['elapsed_seconds']:.3f}s", flush=True)
    print(root)


if __name__ == "__main__":
    main()
