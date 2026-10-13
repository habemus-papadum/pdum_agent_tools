"""Linux process measurements without optional monitoring dependencies."""

from __future__ import annotations

import math
import os
import resource
from pathlib import Path
from statistics import median


def process_table() -> dict[int, dict]:
    """Read host PID identities and parent links, tolerating process exits."""
    table: dict[int, dict] = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            # comm can contain spaces and parentheses; fields after its final ')' are stable.
            stat = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            table[int(directory.name)] = {
                "ppid": int(stat[1]),
                "starttime": int(stat[19]),
                "state": stat[0],
                "user_ticks": int(stat[11]),
                "system_ticks": int(stat[12]),
            }
        except (OSError, ValueError, IndexError):
            continue
    return table


def descendants(roots: list[int], table: dict[int, dict]) -> list[int]:
    """Find owned process descendants in a single observation."""
    selected = set(roots) & table.keys()
    while True:
        added = {pid for pid, info in table.items() if info["ppid"] in selected} - selected
        if not added:
            return sorted(selected)
        selected.update(added)


def process_metrics(roots: list[int]) -> dict:
    """Measure resident/proportional memory, descriptors and process identities."""
    table = process_table()
    pids = descendants(roots, table)
    rows = []
    for pid in pids:
        row = {"pid": pid, **table[pid]}
        directory = Path("/proc") / str(pid)
        for filename, fields in (("status", {"VmRSS:": "rss_kib"}), ("smaps_rollup", {"Pss:": "pss_kib"})):
            try:
                for line in (directory / filename).read_text().splitlines():
                    key, *rest = line.split()
                    if key in fields:
                        row[fields[key]] = int(rest[0])
            except OSError as exc:
                row[filename + "_error"] = exc.strerror
        try:
            row["fd_count"] = len(list((directory / "fd").iterdir()))
            row["mount_namespace"] = os.readlink(directory / "ns" / "mnt")
            row["pid_namespace"] = os.readlink(directory / "ns" / "pid")
        except OSError as exc:
            row["detail_error"] = exc.strerror
        rows.append(row)
    return {
        "process_count": len(rows),
        "rss_kib": sum(row.get("rss_kib", 0) for row in rows),
        "pss_kib": sum(row.get("pss_kib", 0) for row in rows),
        "pss_available_count": sum("pss_kib" in row for row in rows),
        "fd_count": sum(row.get("fd_count", 0) for row in rows),
        "mount_namespace_count": len({row["mount_namespace"] for row in rows if "mount_namespace" in row}),
        "cpu_seconds": sum(row["user_ticks"] + row["system_ticks"] for row in rows) / os.sysconf("SC_CLK_TCK"),
        "rows": rows,
    }


def baseline() -> dict:
    """Measure caller resources that should recover after all environments stop."""
    info = process_metrics([os.getpid()])
    return {
        "caller_fd_count": len(list(Path("/proc/self/fd").iterdir())),
        "caller_mount_count": len(Path("/proc/self/mountinfo").read_text().splitlines()),
        "caller_descendant_count": info["process_count"] - 1,
        "caller_pid": os.getpid(),
    }


def distribution(values: list[float]) -> dict:
    """Summarize milliseconds with a nearest-rank p95."""
    ordered = sorted(values)
    return {
        "samples": len(values),
        "p50_ms": median(ordered),
        "p95_ms": ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)],
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
    }


def cpu_usage() -> dict[str, float]:
    """Read controller and waited-child CPU counters for batch deltas."""
    own = resource.getrusage(resource.RUSAGE_SELF)
    child = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "controller_user_seconds": own.ru_utime,
        "controller_system_seconds": own.ru_stime,
        "waited_child_user_seconds": child.ru_utime,
        "waited_child_system_seconds": child.ru_stime,
    }


def storage_usage(roots: list[Path]) -> dict[str, int]:
    """Count retained files and allocated blocks without walking private host trees."""
    logical_bytes = allocated_bytes = inode_count = 0
    for root in roots:
        root_stat = root.lstat()
        logical_bytes += root_stat.st_size
        allocated_bytes += root_stat.st_blocks * 512
        inode_count += 1
        for directory, directories, files in os.walk(root, followlinks=False):
            for name in directories + files:
                stat = (Path(directory) / name).lstat()
                logical_bytes += stat.st_size
                allocated_bytes += stat.st_blocks * 512
                inode_count += 1
    return {"logical_bytes": logical_bytes, "allocated_bytes": allocated_bytes, "inodes": inode_count}
