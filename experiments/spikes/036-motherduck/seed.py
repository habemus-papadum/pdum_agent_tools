# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Seed the MotherDuck database ``agent_history`` from the two local history files and time every step.

    uv run --frozen --all-packages --env-file .env python -u experiments/spikes/036-motherduck/seed.py

Steps: ``CREATE DATABASE IF NOT EXISTS agent_history`` over an ``md:`` workspace connection, the contract DDL
from ``pdum.agent_history.schema`` inside it, ``ATTACH`` each local file ``READ_ONLY`` in the same connection,
then ``INSERT INTO agent_history.main.<table> SELECT * FROM <local>.main.<table>`` for every table, codex
first. Afterwards it compares row counts per table and source with the local files and records the storage
MotherDuck attributes to the database. A wall-clock budget (default 20 minutes) interrupts the running
statement and marks the load aborted, so a slow path is reported rather than waited out.

Writes ``experiments/artifacts/036-motherduck/seed.json``. A source whose rows are already present is skipped
unless ``--force`` deletes them first; ``--only codex`` restricts the run to one source.
"""

from __future__ import annotations

import argparse
import time
from typing import Any

import common
import duckdb
from pdum.agent_history import schema

ORDER = ["codex", "claude"]


def column_parity(con: duckdb.DuckDBPyConnection, local: str, tables: list[str]) -> list[str]:
    """Return the tables whose column names or types differ between the MotherDuck database and a local file."""
    sql = """
        SELECT table_name, list(column_name || ' ' || data_type ORDER BY ordinal_position)
        FROM information_schema.columns WHERE table_catalog = ? AND table_schema = 'main' GROUP BY 1
    """
    remote = dict(con.execute(sql, [common.DATABASE]).fetchall())
    mine = dict(con.execute(sql, [local]).fetchall())
    return sorted(t for t in tables if remote.get(t) != mine.get(t))


def delete_source(
    con: duckdb.DuckDBPyConnection, local: str, source_id: str, source_tables: list[str]
) -> dict[str, int]:
    """Remove one source's rows from every table so the load can be repeated."""
    deleted: dict[str, int] = {}
    for table in source_tables:
        deleted[table] = con.execute(
            f"DELETE FROM {common.DATABASE}.main.{table} WHERE source_id = ?", [source_id]
        ).fetchone()[0]
    deleted["meta"] = con.execute(
        f"DELETE FROM {common.DATABASE}.main.meta WHERE (key, value) IN (SELECT (key, value) FROM {local}.main.meta)"
    ).fetchone()[0]
    return deleted


def storage(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """What MotherDuck reports for the database, plus the local file sizes for comparison."""
    out: dict[str, Any] = {"local_files": {name: path.stat().st_size for name, path in common.LOCAL_FILES.items()}}
    try:
        rows = con.execute(
            """SELECT database_name, active_bytes, historical_bytes, retained_for_clone_bytes, failsafe_bytes,
                      computed_ts::VARCHAR, created_ts::VARCHAR
               FROM md_information_schema.storage_info WHERE database_name = ? AND deleted_ts IS NULL""",
            [common.DATABASE],
        ).fetchall()
        out["storage_info"] = [
            dict(
                zip(
                    [
                        "database_name",
                        "active_bytes",
                        "historical_bytes",
                        "retained_for_clone_bytes",
                        "failsafe_bytes",
                        "computed_ts",
                        "created_ts",
                    ],
                    r,
                    strict=True,
                )
            )
            for r in rows
        ]
    except Exception as exc:
        out["storage_info_error"] = common.redact(f"{type(exc).__name__}: {exc}")
    try:
        rows = con.execute("PRAGMA database_size").fetchall()
        out["pragma_database_size"] = {r[0]: r[1] for r in rows if r[0] in (common.DATABASE, *common.LOCAL_FILES)}
    except Exception as exc:
        out["pragma_database_size_error"] = common.redact(f"{type(exc).__name__}: {exc}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--budget-minutes", type=float, default=20.0, help="interrupt the load after this much wall clock"
    )
    parser.add_argument("--force", action="store_true", help="delete a source's existing rows before loading it")
    parser.add_argument("--only", choices=ORDER, help="load one source only")
    parser.add_argument("--out", default="seed.json", help="artifact file name")
    args = parser.parse_args()

    report: dict[str, Any] = {
        "started_at": common.now_iso(),
        "database": common.DATABASE,
        "budget_minutes": args.budget_minutes,
        "steps": {},
        "sources": {},
    }
    wall = time.perf_counter()

    start = time.perf_counter()
    con = common.connect_md("md:")
    report["steps"]["connect_s"] = round(time.perf_counter() - start, 3)
    report["versions"] = common.versions(con)

    start = time.perf_counter()
    try:
        con.execute(f"CREATE DATABASE IF NOT EXISTS {common.DATABASE}")
        report["steps"]["create_database"] = {"ok": True, "seconds": round(time.perf_counter() - start, 3)}
    except Exception as exc:
        report["steps"]["create_database"] = {"ok": False, "error": common.redact(f"{type(exc).__name__}: {exc}")}
        common.write_json(args.out, report)
        raise SystemExit(f"CREATE DATABASE failed; the token cannot create databases: {common.redact(str(exc))}")
    con.execute(f"USE {common.DATABASE}")

    # The files are schema v4; only create what they contain so a newer module cannot add empty tables.
    common.attach_local(con, ORDER[0])
    wanted = set(common.tables(con, ORDER[0])) | {name for name, _ in common.view_sql(con, ORDER[0])}
    report["local_schema_version"] = common.local_schema_version(con, ORDER[0])
    statements = [s for s in schema.ddl() if s.split()[5 if s.startswith("CREATE TABLE") else 4] in wanted]
    start = time.perf_counter()
    try:
        for statement in statements:
            con.execute(statement)
        report["steps"]["ddl"] = {
            "ok": True,
            "seconds": round(time.perf_counter() - start, 3),
            "statements": len(statements),
            "module_schema_version": schema.SCHEMA_VERSION,
        }
    except Exception as exc:
        report["steps"]["ddl"] = {"ok": False, "error": common.redact(f"{type(exc).__name__}: {exc}")}
        common.write_json(args.out, report)
        raise SystemExit(f"DDL failed: {common.redact(str(exc))}")
    print(f"database and {len(statements)} DDL statements ready in {report['steps']['ddl']['seconds']} s", flush=True)

    budget = args.budget_minutes * 60
    aborted = False
    for name in ORDER:
        if args.only and name != args.only:
            continue
        if name != ORDER[0]:
            common.attach_local(con, name)
        source_id = con.execute(f"SELECT source_id FROM {name}.main.provenance").fetchone()[0]
        entry: dict[str, Any] = {"source_id": source_id, "file": str(common.LOCAL_FILES[name]), "tables": {}}
        report["sources"][name] = entry
        tables = common.tables(con, name)
        mismatch = column_parity(con, name, tables)
        entry["column_mismatch"] = mismatch
        if mismatch:
            print(f"{name}: column mismatch in {mismatch}; not loading", flush=True)
            continue
        existing = con.execute(
            f"SELECT count(*) FROM {common.DATABASE}.main.threads WHERE source_id = ?", [source_id]
        ).fetchone()[0]
        if existing and not args.force:
            entry["skipped"] = f"{existing} thread rows already present for this source"
            print(f"{name}: {entry['skipped']}; use --force to replace", flush=True)
            continue
        if existing:
            start = time.perf_counter()
            entry["deleted_before_load"] = delete_source(
                con, name, source_id, common.tables_with(con, name, "source_id")
            )
            entry["delete_seconds"] = round(time.perf_counter() - start, 3)
        if aborted:
            entry["skipped"] = "budget exhausted by an earlier source"
            continue

        entry["bytes_item_json"] = con.execute(
            f"SELECT coalesce(sum(length(item_json)), 0) FROM {name}.main.item_blobs"
        ).fetchone()[0]
        source_start = time.perf_counter()
        for table in tables:
            local_rows = con.execute(f"SELECT count(*) FROM {name}.main.{table}").fetchone()[0]
            remaining = budget - (time.perf_counter() - wall)
            if remaining <= 0:
                aborted = True
                entry["tables"][table] = {"rows": local_rows, "aborted": "budget exhausted before start"}
                break
            start = time.perf_counter()
            with common.interrupt_after(con, remaining) as fired:
                try:
                    con.execute(f"INSERT INTO {common.DATABASE}.main.{table} SELECT * FROM {name}.main.{table}")
                    seconds = time.perf_counter() - start
                    entry["tables"][table] = {"rows": local_rows, "seconds": round(seconds, 3)}
                    print(f"{name}.{table:16s} {local_rows:>9,} rows {seconds:8.2f} s", flush=True)
                except Exception as exc:
                    seconds = time.perf_counter() - start
                    text = common.redact(f"{type(exc).__name__}: {exc}")
                    entry["tables"][table] = {
                        "rows": local_rows,
                        "seconds": round(seconds, 3),
                        "error": text,
                        "interrupted": fired.is_set(),
                    }
                    print(
                        f"{name}.{table}: {'interrupted by budget' if fired.is_set() else 'failed'} after {seconds:.1f} s: {text[:200]}",
                        flush=True,
                    )
                    if fired.is_set():
                        aborted = True
                        break
        entry["seconds"] = round(time.perf_counter() - source_start, 3)
        print(f"{name}: {entry['seconds']} s", flush=True)

    report["load_seconds"] = round(time.perf_counter() - wall, 3)
    report["aborted"] = aborted

    # Row counts: MotherDuck rows per source against the local file. ``meta`` has no source_id; compare its total.
    counts: dict[str, Any] = {}
    all_match = True
    for name, entry in report["sources"].items():
        if "source_id" not in entry or entry.get("skipped") or entry.get("column_mismatch"):
            continue
        per_table = {}
        for table in common.tables_with(con, name, "source_id"):
            remote = con.execute(
                f"SELECT count(*) FROM {common.DATABASE}.main.{table} WHERE source_id = ?", [entry["source_id"]]
            ).fetchone()[0]
            local = con.execute(f"SELECT count(*) FROM {name}.main.{table}").fetchone()[0]
            per_table[table] = {"remote": remote, "local": local, "match": remote == local}
            all_match = all_match and remote == local
        counts[name] = per_table
    meta_remote = con.execute(f"SELECT count(*) FROM {common.DATABASE}.main.meta").fetchone()[0]
    meta_local = sum(
        con.execute(f"SELECT count(*) FROM {name}.main.meta").fetchone()[0]
        for name in report["sources"]
        if "file" in report["sources"][name]
    )
    counts["meta"] = {"remote": meta_remote, "local_sum": meta_local, "match": meta_remote == meta_local}
    report["counts"] = counts
    report["counts_match"] = all_match and meta_remote == meta_local
    report["storage"] = storage(con)
    report["finished_at"] = common.now_iso()
    report["total_seconds"] = round(time.perf_counter() - wall, 3)
    path = common.write_json(args.out, report)
    print(
        f"load {report['load_seconds']} s, counts match: {report['counts_match']}, aborted: {aborted}; wrote {path}",
        flush=True,
    )
    con.close()


if __name__ == "__main__":
    main()
