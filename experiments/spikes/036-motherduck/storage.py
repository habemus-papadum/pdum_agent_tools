# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Record what MotherDuck reports about the ``agent_history`` database after the load and the probes.

    uv run --frozen --all-packages --env-file .env python experiments/spikes/036-motherduck/storage.py

``md_information_schema.storage_info`` refreshes every one to six hours, so it can be empty right after a
load; ``PRAGMA database_size`` answers immediately. Both are recorded next to the local file sizes, with the
database row from ``md_information_schema.databases`` (type, not a share) and the per-table estimated sizes.

Writes ``experiments/artifacts/036-motherduck/storage.json``.
"""

from __future__ import annotations

from typing import Any

import common


def attempt(con: Any, label: str, sql: str, params: list[Any] | None, out: dict[str, Any]) -> None:
    """Run one metadata query and store rows or the error text."""
    try:
        out[label] = con.execute(sql, params or []).fetchall()
    except Exception as exc:
        out[label + "_error"] = common.redact(f"{type(exc).__name__}: {exc}")


def main() -> None:
    con = common.connect_md("md:")
    report: dict[str, Any] = {"recorded_at": common.now_iso(), "versions": common.versions(con)}
    report["local_files"] = {name: path.stat().st_size for name, path in common.LOCAL_FILES.items()}
    attempt(
        con,
        "storage_info",
        """SELECT database_name, active_bytes, historical_bytes, retained_for_clone_bytes, failsafe_bytes, computed_ts::VARCHAR, created_ts::VARCHAR
           FROM md_information_schema.storage_info WHERE database_name = ? AND deleted_ts IS NULL""",
        [common.DATABASE],
        report,
    )
    attempt(
        con,
        "pragma_database_size",
        "SELECT database_name, database_size FROM pragma_database_size() WHERE database_name = ?",
        [common.DATABASE],
        report,
    )
    attempt(
        con,
        "databases_row",
        "SELECT name, type, transient, created_ts::VARCHAR FROM md_information_schema.databases WHERE name = ?",
        [common.DATABASE],
        report,
    )
    attempt(
        con,
        "duckdb_databases_row",
        "SELECT database_name, type, readonly FROM duckdb_databases() WHERE database_name = ?",
        [common.DATABASE],
        report,
    )
    attempt(
        con,
        "tables",
        "SELECT table_name, estimated_size FROM duckdb_tables() WHERE database_name = ? ORDER BY table_name",
        [common.DATABASE],
        report,
    )
    attempt(
        con,
        "views",
        "SELECT view_name FROM duckdb_views() WHERE database_name = ? AND NOT internal",
        [common.DATABASE],
        report,
    )
    attempt(con, "duckling_size", "SELECT * FROM md_live_duckling_size()", None, report)
    attempt(
        con,
        "snapshots",
        "SELECT count(*) FROM md_information_schema.database_snapshots WHERE database_name = ?",
        [common.DATABASE],
        report,
    )
    path = common.write_json("storage.json", report)
    for key, value in report.items():
        if key not in ("versions",):
            print(key, value)
    print(f"wrote {path}")
    con.close()


if __name__ == "__main__":
    main()
