"""The DuckDB schema shared by every ingester and by the TypeScript query package.

Every table carries ``source`` (``codex-fs``, ``claude-fs``, ``codex-api``, ``live``) and
``origin`` (the concrete input such as ``state_5``, ``rollout`` or ``thread/items/list``).
Timestamps are naive UTC. Blobs live in their own tables so a later MotherDuck migration can
move them to object storage without touching the fact tables. ``fork_edges`` records which thread
inherited context from which (continued sessions, forks, forked sub-agents) and ``threads.lineage_id``
names the root of that chain, which is what a person means by "a session". :func:`describe` renders the
contract as JSON; the TypeScript package keeps a copy and a parity test fails when they drift.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

try:  # pyarrow turns a row batch into one bulk insert; executemany is the slow fallback
    import pyarrow as _pa
except ImportError:  # pragma: no cover - depends on the environment
    _pa = None

SCHEMA_VERSION = 4
"""Bump when a table, column or view changes shape; the TypeScript parity test reads it."""

COLUMNS: dict[str, list[tuple[str, str]]] = {
    "meta": [
        ("key", "VARCHAR"),
        ("value", "VARCHAR"),
    ],
    "provenance": [
        ("source_id", "VARCHAR"),
        ("host_id", "VARCHAR"),
        ("hostname", "VARCHAR"),
        ("os_user", "VARCHAR"),
        ("platform", "VARCHAR"),
        ("agent", "VARCHAR"),
        ("root", "VARCHAR"),
        ("agent_versions", "VARCHAR"),
        ("window_cutoff", "TIMESTAMP"),
        ("schema_version", "INTEGER"),
        ("ingester_version", "VARCHAR"),
        ("ingested_at", "TIMESTAMP"),
        ("run_id", "VARCHAR"),
    ],
    "threads": [
        ("thread_id", "VARCHAR"),
        ("session_id", "VARCHAR"),
        ("forked_from_id", "VARCHAR"),
        ("parent_thread_id", "VARCHAR"),
        ("lineage_id", "VARCHAR"),
        ("lineage_depth", "INTEGER"),
        ("created_at", "TIMESTAMP"),
        ("updated_at", "TIMESTAMP"),
        ("source_kind", "VARCHAR"),
        ("thread_source", "VARCHAR"),
        ("originator", "VARCHAR"),
        ("cli_version", "VARCHAR"),
        ("model_provider", "VARCHAR"),
        ("cwd", "VARCHAR"),
        ("git_branch", "VARCHAR"),
        ("git_origin", "VARCHAR"),
        ("git_sha", "VARCHAR"),
        ("repo", "VARCHAR"),
        ("title", "VARCHAR"),
        ("preview_len", "INTEGER"),
        ("model", "VARCHAR"),
        ("reasoning_effort", "VARCHAR"),
        ("archived", "BOOLEAN"),
        ("history_mode", "VARCHAR"),
        ("tokens_used", "BIGINT"),
        ("agent_nickname", "VARCHAR"),
        ("agent_role", "VARCHAR"),
        ("agent_path", "VARCHAR"),
        ("rollout_path", "VARCHAR"),
        ("rollout_bytes", "BIGINT"),
        ("rollout_format", "VARCHAR"),
        ("in_window", "BOOLEAN"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "spawn_edges": [
        ("parent_thread_id", "VARCHAR"),
        ("child_thread_id", "VARCHAR"),
        ("status", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "fork_edges": [
        ("parent_thread_id", "VARCHAR"),
        ("child_thread_id", "VARCHAR"),
        ("kind", "VARCHAR"),
        ("evidence", "VARCHAR"),
        ("ambiguous", "BOOLEAN"),
        ("inherited_records", "INTEGER"),
        ("fork_point_ts", "TIMESTAMP"),
        ("child_started_at", "TIMESTAMP"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "turns": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("root_turn_id", "VARCHAR"),
        ("rollout_ordinal", "BIGINT"),
        ("status", "VARCHAR"),
        ("error_message", "VARCHAR"),
        ("error_kind", "VARCHAR"),
        ("started_at", "TIMESTAMP"),
        ("completed_at", "TIMESTAMP"),
        ("duration_ms", "BIGINT"),
        ("time_to_first_token_ms", "BIGINT"),
        ("model", "VARCHAR"),
        ("reasoning_effort", "VARCHAR"),
        ("cwd", "VARCHAR"),
        ("approval_policy", "VARCHAR"),
        ("sandbox_type", "VARCHAR"),
        ("personality", "VARCHAR"),
        ("collaboration_mode", "VARCHAR"),
        ("model_context_window", "BIGINT"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "responses": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("root_turn_id", "VARCHAR"),
        ("session_id", "VARCHAR"),
        ("response_id", "VARCHAR"),
        ("ts", "TIMESTAMP"),
        ("rollout_ordinal", "BIGINT"),
        ("model", "VARCHAR"),
        ("input_tokens", "BIGINT"),
        ("cached_input_tokens", "BIGINT"),
        ("cache_write_input_tokens", "BIGINT"),
        ("cache_write_1h_input_tokens", "BIGINT"),
        ("output_tokens", "BIGINT"),
        ("reasoning_output_tokens", "BIGINT"),
        ("wasted_output_tokens", "BIGINT"),
        ("total_tokens", "BIGINT"),
        ("turn_input_tokens", "BIGINT"),
        ("turn_cached_input_tokens", "BIGINT"),
        ("turn_output_tokens", "BIGINT"),
        ("turn_total_tokens", "BIGINT"),
        ("thread_input_tokens", "BIGINT"),
        ("thread_cached_input_tokens", "BIGINT"),
        ("thread_output_tokens", "BIGINT"),
        ("thread_total_tokens", "BIGINT"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "token_counts": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("ts", "TIMESTAMP"),
        ("rollout_ordinal", "BIGINT"),
        ("total_input_tokens", "BIGINT"),
        ("total_cached_input_tokens", "BIGINT"),
        ("total_cache_write_input_tokens", "BIGINT"),
        ("total_output_tokens", "BIGINT"),
        ("total_reasoning_output_tokens", "BIGINT"),
        ("total_tokens", "BIGINT"),
        ("last_input_tokens", "BIGINT"),
        ("last_cached_input_tokens", "BIGINT"),
        ("last_cache_write_input_tokens", "BIGINT"),
        ("last_output_tokens", "BIGINT"),
        ("last_reasoning_output_tokens", "BIGINT"),
        ("last_total_tokens", "BIGINT"),
        ("model_context_window", "BIGINT"),
        ("limit_id", "VARCHAR"),
        ("plan_type", "VARCHAR"),
        ("primary_used_percent", "DOUBLE"),
        ("primary_window_minutes", "BIGINT"),
        ("primary_resets_at", "TIMESTAMP"),
        ("secondary_used_percent", "DOUBLE"),
        ("secondary_window_minutes", "BIGINT"),
        ("secondary_resets_at", "TIMESTAMP"),
        ("credits_balance", "DOUBLE"),
        ("credits_unlimited", "BOOLEAN"),
        ("rate_limit_reached_type", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "items": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("item_id", "VARCHAR"),
        ("rollout_ordinal", "BIGINT"),
        ("item_type", "VARCHAR"),
        ("created_at", "TIMESTAMP"),
        ("started_at", "TIMESTAMP"),
        ("completed_at", "TIMESTAMP"),
        ("duration_ms", "BIGINT"),
        ("status", "VARCHAR"),
        ("command", "VARCHAR"),
        ("command_program", "VARCHAR"),
        ("command_action", "VARCHAR"),
        ("cwd", "VARCHAR"),
        ("process_id", "VARCHAR"),
        ("exec_source", "VARCHAR"),
        ("exit_code", "INTEGER"),
        ("exec_duration_ms", "BIGINT"),
        ("output_bytes", "BIGINT"),
        ("output_truncated", "BOOLEAN"),
        ("server", "VARCHAR"),
        ("tool", "VARCHAR"),
        ("mcp_error", "BOOLEAN"),
        ("n_parts", "INTEGER"),
        ("added_lines", "INTEGER"),
        ("deleted_lines", "INTEGER"),
        ("paths", "VARCHAR"),
        ("text", "VARCHAR"),
        ("text_len", "INTEGER"),
        ("has_mermaid", "BOOLEAN"),
        ("image_count", "INTEGER"),
        ("agent_kind", "VARCHAR"),
        ("agent_thread_id", "VARCHAR"),
        ("agent_path", "VARCHAR"),
        ("item_json_bytes", "INTEGER"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "item_blobs": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("item_id", "VARCHAR"),
        ("item_json", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "rollout_events": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("ts", "TIMESTAMP"),
        ("rollout_ordinal", "BIGINT"),
        ("event_type", "VARCHAR"),
        ("detail", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "response_items": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("ts", "TIMESTAMP"),
        ("create_time", "TIMESTAMP"),
        ("rollout_ordinal", "BIGINT"),
        ("item_type", "VARCHAR"),
        ("role", "VARCHAR"),
        ("name", "VARCHAR"),
        ("call_id", "VARCHAR"),
        ("text_len", "INTEGER"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "logs": [
        ("ts", "TIMESTAMP"),
        ("level", "VARCHAR"),
        ("target", "VARCHAR"),
        ("thread_id", "VARCHAR"),
        ("process_uuid", "VARCHAR"),
        ("body", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "coverage": [
        ("thread_id", "VARCHAR"),
        ("in_window", "BOOLEAN"),
        ("in_catalogue", "BOOLEAN"),
        ("in_projection", "BOOLEAN"),
        ("rollout_format", "VARCHAR"),
        ("rollout_lines", "INTEGER"),
        ("turn_contexts", "INTEGER"),
        ("usage_records", "INTEGER"),
        ("token_counts", "INTEGER"),
        ("projection_turns", "INTEGER"),
        ("projection_items", "INTEGER"),
        ("rollout_item_completed", "INTEGER"),
        ("response_items", "INTEGER"),
        ("compactions", "INTEGER"),
        ("unknown_line_types", "INTEGER"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "ingest_runs": [
        ("run_id", "VARCHAR"),
        ("source_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("phase", "VARCHAR"),
        ("started_at", "TIMESTAMP"),
        ("seconds", "DOUBLE"),
        ("rows", "BIGINT"),
        ("detail", "VARCHAR"),
    ],
}

VIEWS: dict[str, str] = {
    "usage_events": """
SELECT source_id, thread_id, turn_id, ts, rollout_ordinal, model, input_tokens, cached_input_tokens,
       cache_write_input_tokens, cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens,
       wasted_output_tokens, total_tokens, 'usage_record' AS basis, source
FROM (SELECT * FROM responses WHERE origin <> 'copied-context'
      QUALIFY row_number() OVER (PARTITION BY source, response_id ORDER BY ts, rollout_ordinal) = 1)
UNION ALL
SELECT source_id, thread_id, turn_id, ts, rollout_ordinal, NULL AS model,
       total_input_tokens - prev_input, total_cached_input_tokens - prev_cached,
       total_cache_write_input_tokens - prev_cache_write, NULL AS cache_write_1h_input_tokens,
       total_output_tokens - prev_output, total_reasoning_output_tokens - prev_reasoning, NULL AS wasted_output_tokens,
       total_tokens - prev_total, 'counter_delta' AS basis, source
FROM (SELECT *,
             lag(total_input_tokens, 1, 0) OVER w AS prev_input,
             lag(total_cached_input_tokens, 1, 0) OVER w AS prev_cached,
             lag(COALESCE(total_cache_write_input_tokens, 0), 1, 0) OVER w AS prev_cache_write,
             lag(total_output_tokens, 1, 0) OVER w AS prev_output,
             lag(total_reasoning_output_tokens, 1, 0) OVER w AS prev_reasoning,
             lag(total_tokens, 1, 0) OVER w AS prev_total
      FROM token_counts
      WHERE total_tokens IS NOT NULL AND thread_id NOT IN (SELECT DISTINCT thread_id FROM responses)
      WINDOW w AS (PARTITION BY thread_id ORDER BY rollout_ordinal))
WHERE total_tokens - prev_total > 0
""",
}
"""Per-response usage where recorded, else positive deltas of cumulative counters.

Threads with usage records never enter the delta branch, so nothing is counted twice, and responses a
file copied from another session or parent (``origin = 'copied-context'``) are left out. The
first counter value of a thread counts as an increment from zero; a fork inherits its parent's
counters, so that first increment can include inherited history.
"""


def ddl() -> list[str]:
    """Return the CREATE statements for every table and view, in dependency order."""
    statements = []
    for table, columns in COLUMNS.items():
        rendered = ", ".join(f"{name} {kind}" for name, kind in columns)
        statements.append(f"CREATE TABLE IF NOT EXISTS {table} ({rendered})")
    for view, body in VIEWS.items():
        statements.append(f"CREATE OR REPLACE VIEW {view} AS {body.strip()}")
    return statements


def create(connection: Any) -> None:
    """Create every table and view when absent.

    Parameters
    ----------
    connection : duckdb.DuckDBPyConnection
        Open connection to the target database.
    """
    for statement in ddl():
        connection.execute(statement)


def describe() -> dict[str, Any]:
    """Render the schema contract as JSON-compatible data.

    Returns
    -------
    dict
        ``{"version": int, "tables": {name: [[column, type], ...]}, "views": {name: sql}}``.
    """
    return {
        "version": SCHEMA_VERSION,
        "tables": {table: [list(column) for column in columns] for table, columns in COLUMNS.items()},
        "views": {view: " ".join(body.split()) for view, body in VIEWS.items()},
    }


def describe_json() -> str:
    """Return :func:`describe` as stable, indented JSON text."""
    return json.dumps(describe(), indent=2, sort_keys=True) + "\n"


def row(table: str, **values: Any) -> tuple:
    """Return a tuple in column order; unnamed columns are NULL.

    Parameters
    ----------
    table : str
        Table name in :data:`COLUMNS`.
    **values : Any
        Column values by name.
    """
    names = [name for name, _ in COLUMNS[table]]
    unknown = set(values) - set(names)
    if unknown:
        raise KeyError(f"{table} has no columns {sorted(unknown)}")
    return tuple(values.get(name) for name in names)


_ARROW_TYPES = {
    "VARCHAR": lambda: _pa.string(),
    "BIGINT": lambda: _pa.int64(),
    "INTEGER": lambda: _pa.int32(),
    "DOUBLE": lambda: _pa.float64(),
    "BOOLEAN": lambda: _pa.bool_(),
    "TIMESTAMP": lambda: _pa.timestamp("us"),
}


def insert(connection: Any, table: str, rows: list[tuple]) -> int:
    """Insert rows as one Arrow batch when pyarrow is present, else statement by statement.

    Parameters
    ----------
    connection : duckdb.DuckDBPyConnection
        Open connection.
    table : str
        Target table.
    rows : list of tuple
        Rows built with :func:`row`.

    Returns
    -------
    int
        Number of rows inserted.
    """
    if not rows:
        return 0
    if _pa is not None:
        names = [name for name, _ in COLUMNS[table]]
        arrow_schema = _pa.schema([(name, _ARROW_TYPES[kind]()) for name, kind in COLUMNS[table]])
        columns = list(zip(*rows, strict=True))
        batch = _pa.table(
            {
                name: _pa.array(values, type=arrow_schema.field(name).type)
                for name, values in zip(names, columns, strict=True)
            }
        )
        connection.register("_insert_batch", batch)
        connection.execute(f"INSERT INTO {table} SELECT * FROM _insert_batch")
        connection.unregister("_insert_batch")
        return len(rows)
    placeholders = ", ".join("?" for _ in COLUMNS[table])
    connection.executemany(f"INSERT INTO {table} VALUES ({placeholders})", rows)
    return len(rows)


def from_ms(value: Any) -> datetime | None:
    """Convert epoch milliseconds, or seconds when the number is small, to naive UTC."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    if number < 1e11:
        number *= 1000
    return datetime.fromtimestamp(number / 1000, tz=UTC).replace(tzinfo=None)


def from_iso(value: Any) -> datetime | None:
    """Convert ISO-8601 text such as ``2026-10-06T13:30:29.834Z`` to naive UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed
