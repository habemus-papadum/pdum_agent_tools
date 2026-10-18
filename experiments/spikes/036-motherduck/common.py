# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Shared helpers for spike 036: the MotherDuck connection, the local history files, timing and artifacts.

The token is read from the ``MOTHERDUCK_BROWSER_TOKEN`` environment variable and handed to DuckDB as the
``motherduck_token`` setting. Nothing here prints, logs or writes it; error text that passes through
:func:`redact` has the token value removed in case a driver message ever echoes it.

Table lists come from the local files' own catalogues, not from the live ``pdum.agent_history.schema``
module: the files are schema version 4 and the module moved on during the spike.
"""

from __future__ import annotations

import json
import os
import platform
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb

REPO = Path(__file__).resolve().parents[3]
ARTIFACTS = REPO / "experiments" / "artifacts" / "036-motherduck"
HISTORY = Path.home() / "history"
LOCAL_FILES: dict[str, Path] = {"codex": HISTORY / "codex.duckdb", "claude": HISTORY / "claude.duckdb"}
DATABASE = "agent_history"
TOKEN_VAR = "MOTHERDUCK_BROWSER_TOKEN"
USER_AGENT = "agent-skills/2.6.0(harness-claude-code;llm-claude-fable-5-1)"


def token() -> str:
    """Return the MotherDuck token from the environment or fail loudly without echoing anything."""
    value = os.environ.get(TOKEN_VAR)
    if not value:
        raise SystemExit(
            f"{TOKEN_VAR} is not set; run with `uv run --frozen --all-packages --env-file .env python ...`"
        )
    return value


def redact(text: str) -> str:
    """Remove the token value from text that may be stored or printed."""
    value = os.environ.get(TOKEN_VAR)
    return text.replace(value, "<token>") if value else text


def connect_md(target: str = "md:", **settings: Any) -> duckdb.DuckDBPyConnection:
    """Open a native DuckDB connection to MotherDuck.

    Parameters
    ----------
    target : str
        ``md:`` for the workspace or ``md:<database>`` for one database.
    **settings : Any
        Extra DuckDB configuration options.
    """
    config = {"motherduck_token": token(), "custom_user_agent": USER_AGENT, **settings}
    return duckdb.connect(target, config=config)


def attach_local(con: duckdb.DuckDBPyConnection, name: str, read_only: bool = True) -> None:
    """Attach one local history file under its short name."""
    path = LOCAL_FILES[name]
    if not path.exists():
        raise SystemExit(f"missing local history file {path}")
    mode = " (READ_ONLY)" if read_only else ""
    con.execute(f"ATTACH '{path}' AS {name}{mode}")


def tables(con: duckdb.DuckDBPyConnection, catalog: str) -> list[str]:
    """Base tables of ``catalog.main`` in catalogue order (the order the ingester created them)."""
    rows = con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = ? AND schema_name = 'main' AND NOT internal ORDER BY table_oid",
        [catalog],
    ).fetchall()
    return [r[0] for r in rows]


def tables_with(con: duckdb.DuckDBPyConnection, catalog: str, column: str) -> list[str]:
    """Base tables of ``catalog.main`` that have a column of this name."""
    rows = con.execute(
        """SELECT t.table_name FROM duckdb_tables() t
           JOIN duckdb_columns() c ON c.table_oid = t.table_oid
           WHERE t.database_name = ? AND t.schema_name = 'main' AND NOT t.internal AND c.column_name = ?
           ORDER BY t.table_oid""",
        [catalog, column],
    ).fetchall()
    return [r[0] for r in rows]


def view_sql(con: duckdb.DuckDBPyConnection, catalog: str) -> list[tuple[str, str]]:
    """``(name, CREATE VIEW ...)`` for every view in ``catalog.main``."""
    rows = con.execute(
        "SELECT view_name, sql FROM duckdb_views() WHERE database_name = ? AND schema_name = 'main' AND NOT internal ORDER BY view_name",
        [catalog],
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def local_schema_version(con: duckdb.DuckDBPyConnection, catalog: str) -> str | None:
    """The ``schema_version`` the ingester wrote into the file's ``meta`` table."""
    row = con.execute(f"SELECT value FROM {catalog}.main.meta WHERE key = 'schema_version'").fetchone()
    return row[0] if row else None


def connect_local_union() -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB with both local files attached read-only and one UNION ALL view per table.

    The files' own views (``usage_events``) are recreated on top of the union views, so the same SQL text
    runs unchanged against this connection and against ``md:agent_history``.
    """
    con = duckdb.connect()
    for name in LOCAL_FILES:
        attach_local(con, name)
    names = list(LOCAL_FILES)
    common = [t for t in tables(con, names[0]) if all(t in tables(con, n) for n in names[1:])]
    for table in common:
        union = " UNION ALL ".join(f"SELECT * FROM {name}.main.{table}" for name in names)
        con.execute(f"CREATE VIEW {table} AS {union}")
    for _, sql in view_sql(con, names[0]):
        con.execute(sql)
    return con


def versions(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Record the DuckDB and MotherDuck extension versions seen by a connection."""
    duck = con.execute("PRAGMA version").fetchone()
    ext = con.execute(
        "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'motherduck' AND loaded"
    ).fetchone()
    return {
        "duckdb": duck[0] if duck else None,
        "duckdb_python": duckdb.__version__,
        "motherduck_extension": ext[0] if ext else None,
        "python": platform.python_version(),
        "platform": platform.platform(),
    }


@contextmanager
def interrupt_after(con: duckdb.DuckDBPyConnection, seconds: float):
    """Interrupt the connection's running statement when a wall-clock budget runs out."""
    fired = threading.Event()

    def fire() -> None:
        fired.set()
        con.interrupt()

    timer = threading.Timer(seconds, fire)
    timer.daemon = True
    timer.start()
    try:
        yield fired
    finally:
        timer.cancel()


def ms(seconds: float) -> float:
    """Round seconds to one decimal millisecond."""
    return round(seconds * 1000, 1)


def timed(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> tuple[float, list[tuple]]:
    """Run one statement, fetch every row, and return (seconds, rows)."""
    start = time.perf_counter()
    rows = con.execute(sql, params or []).fetchall()
    return time.perf_counter() - start, rows


def now_iso() -> str:
    """UTC timestamp for artifact headers."""
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def write_json(name: str, data: dict[str, Any]) -> Path:
    """Write one artifact file under the ignored artifact directory and return its path."""
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / name
    path.write_text(json.dumps(data, indent=2, default=str) + "\n")
    return path


def read_json(name: str) -> dict[str, Any]:
    """Read one artifact file."""
    return json.loads((ARTIFACTS / name).read_text())
