"""Render the spike's result tables from one artifact directory as Markdown.

uv run --project .. python spikes/035-codex-analysis/report_tables.py artifacts/035-codex-analysis/<run>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def load(path: Path) -> Any:
    return json.loads(path.read_text()) if path.exists() else None


def table(headers: list[str], rows: list[list[Any]], align_right_from: int = 1) -> str:
    sep = ["---"] * align_right_from + ["---:"] * (len(headers) - align_right_from)
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(sep) + " |"]
    for row in rows:
        lines.append("| " + " | ".join("" if v is None else str(v) for v in row) + " |")
    return "\n".join(lines)


def main(run: Path) -> None:
    fs = load(run / "ingest_fs.json")
    questions = load(run / "questions.json")
    snapshot = load(run / "ingest_api_snapshot.json")
    daemon = load(run / "ingest_api_daemon.json")
    resume = load(run / "ingest_api_snapshot-resume.json")
    run_api = load(run / "run_api.json")
    compare_snapshot = load(run / "compare_snapshot.json")
    live = load(run / "live" / "live_probe.json")

    print("### Filesystem ingest\n")
    rows = [[name, p["seconds"], p["rows"], p["detail"]] for name, p in fs["phases"].items()]
    rows.append(
        ["total", fs["total_seconds"], sum(fs["tables"].values()), f"DuckDB file {fs['db_bytes'] / 1e6:.0f} MB"]
    )
    print(table(["Phase", "Seconds", "Rows", "Detail"], rows, 1))
    print()
    print("### Questions over the filesystem tables\n")
    rows = []
    for q in questions:
        if q["id"] == "open":
            continue
        rows.append(
            [
                q["id"],
                q["title"],
                ", ".join(q["tables"]),
                q.get("cold_ms"),
                q.get("warm_ms"),
                q.get("rows") if "error" not in q else "error",
            ]
        )
    print(table(["Id", "Question", "Tables", "Cold ms", "Warm ms", "Rows"], rows, 3))
    print()

    def methods(summary: dict[str, Any] | None, label: str) -> None:
        if not summary:
            return
        print(f"### API path: {label}\n")
        rows = [
            [m, s["calls"], s["errors"], s["p50_ms"], s["p95_ms"], s["max_ms"], s["total_ms"], s["rows"]]
            for m, s in summary["methods"].items()
        ]
        print(table(["Method", "Calls", "Errors", "p50 ms", "p95 ms", "Max ms", "Total ms", "Rows"], rows, 1))
        print()
        print(
            f"Wall {summary['wall_seconds']} s for {summary['rpc_calls']} calls; tables: "
            + ", ".join(f"{k} {v}" for k, v in summary["tables"].items() if v)
        )
        print()

    methods(snapshot, "launched server on a snapshot profile (all listed threads)")
    methods(daemon, "managed daemon, read-only (first 40 listed threads)")
    methods(resume, "snapshot without a copied projection, materialized by thread/resume (40 threads)")
    if run_api and run_api.get("snapshot"):
        s = run_api["snapshot"]
        print(
            "Snapshot setup: clone",
            s.get("clone_seconds"),
            "s; history backup",
            (s.get("history_backup") or {}).get("seconds"),
            "s;",
            "launch",
            s.get("launch_seconds"),
            "s; backfill",
            (s.get("backfill") or {}).get("threads"),
            "threads at first poll;",
            s.get("version"),
        )
        sweep = s.get("concurrency_sweep") or []
        if sweep:
            print()
            print(
                table(
                    ["Concurrency", "Wall s", "Calls", "items/list p50 ms"],
                    [
                        [
                            w["concurrency"],
                            w["wall_seconds"],
                            w["rpc_calls"],
                            w["methods"].get("thread/items/list", {}).get("p50_ms"),
                        ]
                        for w in sweep
                    ],
                    0,
                )
            )
        print()
    if compare_snapshot:
        c = compare_snapshot
        print("### Snapshot API tables against filesystem tables\n")
        print(table(["Table", "fs rows", "api rows"], [[t, v["fs"], v["api"]] for t, v in c["tables"].items()], 1))
        print()
        print("Threads:", json.dumps(c["threads"], default=str))
        print("Turns:", json.dumps(c["turns"], default=str))
        print("Items:", json.dumps(c["items"], default=str))
        print()
    if live:
        print("### Live turn\n")
        keep = {
            k: live.get(k)
            for k in (
                "model",
                "turn_status",
                "turn_wall_seconds",
                "thread_start_ms",
                "notification_methods",
                "live_tables",
                "final_usage_total",
                "observed_api_equivalent_usd",
                "source_auth_unchanged",
            )
        }
        print(json.dumps(keep, indent=1))
        print("Persisted:", json.dumps((live.get("persisted") or {}).get("coverage")))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
