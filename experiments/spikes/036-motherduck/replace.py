# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Replace one Codex thread in ``agent_history`` inside a single transaction and prove nothing changed.

    uv run --frozen --all-packages --env-file .env python -u experiments/spikes/036-motherduck/replace.py [--thread ID]

This is the incremental pattern an ingester would use for a thread whose rollout grew: in one transaction,
``DELETE FROM <table> WHERE source_id = ? AND thread_id = ?`` for every table that carries ``thread_id``, then
re-insert that thread's rows from the local file attached read-only in the same connection. Row counts per
table are taken before and after, for the thread and for the whole table, and must be identical. Without
``--thread`` the Codex thread with the most ``item_blobs`` rows between 200 and 600 is used.

Writes ``experiments/artifacts/036-motherduck/replace.json``.
"""

from __future__ import annotations

import argparse
import time
from typing import Any

import common
import duckdb

LOCAL = "codex"


def counts(con: duckdb.DuckDBPyConnection, tables: list[str], source_id: str, thread: str) -> dict[str, dict[str, int]]:
    """Rows per thread table: this thread's rows and the whole table."""
    out = {}
    for table in tables:
        mine = con.execute(
            f"SELECT count(*) FROM {common.DATABASE}.main.{table} WHERE source_id = ? AND thread_id = ?",
            [source_id, thread],
        ).fetchone()[0]
        total = con.execute(f"SELECT count(*) FROM {common.DATABASE}.main.{table}").fetchone()[0]
        out[table] = {"thread": mine, "total": total}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--thread", help="Codex thread id; default picks a mid-sized one deterministically")
    parser.add_argument("--out", default="replace.json")
    args = parser.parse_args()

    con = common.connect_md("md:")
    con.execute(f"USE {common.DATABASE}")
    common.attach_local(con, LOCAL)
    tables = common.tables_with(con, LOCAL, "thread_id")
    report: dict[str, Any] = {"started_at": common.now_iso(), "tables": tables, "versions": common.versions(con)}
    report["local_schema_version"] = common.local_schema_version(con, LOCAL)
    source_id = con.execute(f"SELECT source_id FROM {LOCAL}.main.provenance").fetchone()[0]
    thread = (
        args.thread
        or con.execute(
            f"SELECT thread_id FROM {LOCAL}.main.item_blobs GROUP BY 1 HAVING count(*) BETWEEN 200 AND 600 ORDER BY count(*) DESC, thread_id LIMIT 1"
        ).fetchone()[0]
    )
    report["source_id"] = source_id
    report["thread_id"] = thread
    report["local_rows"] = {
        table: con.execute(
            f"SELECT count(*) FROM {LOCAL}.main.{table} WHERE source_id = ? AND thread_id = ?", [source_id, thread]
        ).fetchone()[0]
        for table in tables
    }
    report["before"] = counts(con, tables, source_id, thread)

    steps: list[dict[str, Any]] = []
    wall = time.perf_counter()
    try:
        con.execute("BEGIN")
        for table in tables:
            t0 = time.perf_counter()
            deleted = con.execute(
                f"DELETE FROM {common.DATABASE}.main.{table} WHERE source_id = ? AND thread_id = ?", [source_id, thread]
            ).fetchone()[0]
            t1 = time.perf_counter()
            con.execute(
                f"INSERT INTO {common.DATABASE}.main.{table} SELECT * FROM {LOCAL}.main.{table} WHERE source_id = ? AND thread_id = ?",
                [source_id, thread],
            )
            t2 = time.perf_counter()
            steps.append(
                {"table": table, "deleted": deleted, "delete_ms": common.ms(t1 - t0), "insert_ms": common.ms(t2 - t1)}
            )
            print(
                f"{table:16s} deleted {deleted:>6,} delete {common.ms(t1 - t0):8.1f} ms insert {common.ms(t2 - t1):8.1f} ms",
                flush=True,
            )
        t0 = time.perf_counter()
        con.execute("COMMIT")
        report["commit_ms"] = common.ms(time.perf_counter() - t0)
        report["ok"] = True
    except Exception as exc:
        report["ok"] = False
        report["error"] = common.redact(f"{type(exc).__name__}: {exc}")
        try:
            con.execute("ROLLBACK")
        except Exception as exc2:
            report["rollback_error"] = common.redact(f"{type(exc2).__name__}: {exc2}")
    report["transaction_seconds"] = round(time.perf_counter() - wall, 3)
    report["steps"] = steps
    report["after"] = counts(con, tables, source_id, thread)
    report["unchanged"] = report["before"] == report["after"] and all(
        report["after"][t]["thread"] == report["local_rows"][t] for t in tables
    )
    report["finished_at"] = common.now_iso()
    con.close()
    path = common.write_json(args.out, report)
    print(
        f"ok={report['ok']} transaction {report['transaction_seconds']} s unchanged={report['unchanged']}; wrote {path}",
        flush=True,
    )


if __name__ == "__main__":
    main()
