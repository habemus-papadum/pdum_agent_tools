# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Two writer processes against one scratch table in ``agent_history``.

    uv run --frozen --all-packages --env-file .env python -u experiments/spikes/036-motherduck/concurrency.py

The controller creates ``ingest_probe(source_id, thread_id, n, payload)``, starts two copies of this script in
``worker`` mode with their own ``source_id`` and a shared start time, waits for both, checks the row counts and
drops the table. Each worker holds its own ``md:agent_history`` connection, builds 10,000 rows in a local
temporary table (so the insert uploads through the hybrid bridge like a real ingest would) and repeats five
times: ``BEGIN; DELETE ... WHERE source_id = ?; INSERT 10,000 rows; COMMIT``. Errors are recorded as text and
the transaction is rolled back before the next attempt.

Writes ``experiments/artifacts/036-motherduck/concurrency.json`` (per-worker files alongside).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import common

TABLE = "ingest_probe"
WORKERS = ["probe-a", "probe-b"]


def worker(source_id: str, start_at: float, iterations: int, rows: int, out: Path) -> None:
    """One writer process: connect, stage rows locally, then run the delete-and-insert transactions."""
    result: dict[str, Any] = {
        "source_id": source_id,
        "pid": os.getpid(),
        "iterations": [],
        "rows_per_transaction": rows,
    }
    start = time.perf_counter()
    con = common.connect_md(f"md:{common.DATABASE}")
    result["connect_s"] = round(time.perf_counter() - start, 3)
    con.execute(
        """CREATE TEMP TABLE probe_rows AS
           SELECT 'thread-' || (i % 50)::VARCHAR AS thread_id, i::INTEGER AS n,
                  repeat(chr(97 + (i % 26)::INTEGER), 200) AS payload
           FROM range(?) t(i)""",
        [rows],
    )
    delay = start_at - time.time()
    if delay > 0:
        time.sleep(delay)
    result["started_at"] = common.now_iso()
    for k in range(iterations):
        rec: dict[str, Any] = {"iteration": k}
        t0 = time.perf_counter()
        try:
            con.execute("BEGIN")
            t1 = time.perf_counter()
            deleted = con.execute(f"DELETE FROM {TABLE} WHERE source_id = ?", [source_id]).fetchone()[0]
            t2 = time.perf_counter()
            con.execute(f"INSERT INTO {TABLE} SELECT ?, thread_id, n, payload FROM probe_rows", [source_id])
            t3 = time.perf_counter()
            con.execute("COMMIT")
            t4 = time.perf_counter()
            rec.update(
                {
                    "ok": True,
                    "deleted": deleted,
                    "delete_ms": common.ms(t2 - t1),
                    "insert_ms": common.ms(t3 - t2),
                    "commit_ms": common.ms(t4 - t3),
                }
            )
        except Exception as exc:
            rec["ok"] = False
            rec["error"] = common.redact(f"{type(exc).__name__}: {exc}")
            try:
                con.execute("ROLLBACK")
            except Exception as exc2:
                rec["rollback_error"] = common.redact(f"{type(exc2).__name__}: {exc2}")
        rec["total_ms"] = common.ms(time.perf_counter() - t0)
        result["iterations"].append(rec)
        print(f"{source_id} #{k} ok={rec['ok']} {rec['total_ms']} ms", flush=True)
    result["finished_at"] = common.now_iso()
    con.close()
    out.write_text(__import__("json").dumps(result, indent=2) + "\n")


def controller(iterations: int, rows: int, out: str) -> None:
    """Create the scratch table, run both workers at once, verify, drop, and write the artifact."""
    report: dict[str, Any] = {
        "started_at": common.now_iso(),
        "table": TABLE,
        "iterations": iterations,
        "rows_per_transaction": rows,
    }
    con = common.connect_md(f"md:{common.DATABASE}")
    report["versions"] = common.versions(con)
    con.execute(f"CREATE OR REPLACE TABLE {TABLE} (source_id VARCHAR, thread_id VARCHAR, n INTEGER, payload VARCHAR)")
    common.ARTIFACTS.mkdir(parents=True, exist_ok=True)
    start_at = time.time() + 12.0
    procs = []
    for source_id in WORKERS:
        path = common.ARTIFACTS / f"concurrency-{source_id}.json"
        cmd = [
            sys.executable,
            "-u",
            __file__,
            "worker",
            "--source-id",
            source_id,
            "--start-at",
            str(start_at),
            "--iterations",
            str(iterations),
            "--rows",
            str(rows),
            "--out",
            str(path),
        ]
        procs.append((source_id, path, subprocess.Popen(cmd, env=os.environ.copy(), cwd=str(Path(__file__).parent))))
    wall = time.perf_counter()
    report["workers"] = {}
    for source_id, path, proc in procs:
        code = proc.wait()
        entry: dict[str, Any] = {"exit_code": code}
        if path.exists():
            entry.update(common.read_json(path.name))
        report["workers"][source_id] = entry
    report["wall_seconds_after_spawn"] = round(time.perf_counter() - wall, 3)
    report["final_counts"] = dict(
        con.execute(f"SELECT source_id, count(*) FROM {TABLE} GROUP BY 1 ORDER BY 1").fetchall()
    )
    report["expected_per_source"] = rows
    report["all_ok"] = all(
        w["exit_code"] == 0
        and all(it.get("ok") for it in w.get("iterations", []))
        and len(w.get("iterations", [])) == iterations
        for w in report["workers"].values()
    ) and all(report["final_counts"].get(s) == rows for s in WORKERS)
    con.execute(f"DROP TABLE IF EXISTS {TABLE}")
    report["dropped"] = True
    report["finished_at"] = common.now_iso()
    con.close()
    path = common.write_json(out, report)
    print(f"all_ok={report['all_ok']} counts={report['final_counts']}; wrote {path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", nargs="?", choices=["controller", "worker"], default="controller")
    parser.add_argument("--source-id")
    parser.add_argument("--start-at", type=float, default=0.0)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--rows", type=int, default=10_000)
    parser.add_argument("--out", default="concurrency.json")
    args = parser.parse_args()
    if args.mode == "worker":
        worker(args.source_id, args.start_at, args.iterations, args.rows, Path(args.out))
    else:
        controller(args.iterations, args.rows, args.out)


if __name__ == "__main__":
    main()
