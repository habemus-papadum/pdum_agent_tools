"""DuckDB schema shared by every ingester in spike 035.

Every table carries ``source`` (fs | api | live) and ``origin`` (the concrete input
such as ``state_5``, ``rollout``, ``thread/items/list`` or ``item/completed``) so SQL can
ask which access path produced a fact and compare paths row for row. Timestamps are
naive UTC. Nothing here depends on the launcher or on DuckDB extensions.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

COLUMNS: dict[str, list[tuple[str, str]]] = {
    "threads": [
        ("thread_id", "VARCHAR"),
        ("session_id", "VARCHAR"),
        ("forked_from_id", "VARCHAR"),
        ("parent_thread_id", "VARCHAR"),
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
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "spawn_edges": [
        ("parent_thread_id", "VARCHAR"),
        ("child_thread_id", "VARCHAR"),
        ("status", "VARCHAR"),
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
        ("input_tokens", "BIGINT"),
        ("cached_input_tokens", "BIGINT"),
        ("cache_write_input_tokens", "BIGINT"),
        ("output_tokens", "BIGINT"),
        ("reasoning_output_tokens", "BIGINT"),
        ("total_tokens", "BIGINT"),
        ("turn_input_tokens", "BIGINT"),
        ("turn_cached_input_tokens", "BIGINT"),
        ("turn_output_tokens", "BIGINT"),
        ("turn_total_tokens", "BIGINT"),
        ("thread_input_tokens", "BIGINT"),
        ("thread_cached_input_tokens", "BIGINT"),
        ("thread_output_tokens", "BIGINT"),
        ("thread_total_tokens", "BIGINT"),
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
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "command_outputs": [
        ("thread_id", "VARCHAR"),
        ("turn_id", "VARCHAR"),
        ("item_id", "VARCHAR"),
        ("output", "VARCHAR"),
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
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "coverage": [
        ("thread_id", "VARCHAR"),
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
        ("source", "VARCHAR"),
        ("origin", "VARCHAR"),
    ],
    "ingest_runs": [
        ("run_id", "VARCHAR"),
        ("source", "VARCHAR"),
        ("phase", "VARCHAR"),
        ("started_at", "TIMESTAMP"),
        ("seconds", "DOUBLE"),
        ("rows", "BIGINT"),
        ("detail", "VARCHAR"),
    ],
    "rpc_calls": [
        ("run_id", "VARCHAR"),
        ("method", "VARCHAR"),
        ("params_summary", "VARCHAR"),
        ("started_at", "TIMESTAMP"),
        ("ms", "DOUBLE"),
        ("ok", "BOOLEAN"),
        ("result_rows", "INTEGER"),
        ("error", "VARCHAR"),
    ],
}


def create(connection: Any) -> None:
    """Create every table when absent."""
    for table, columns in COLUMNS.items():
        rendered = ", ".join(f"{name} {kind}" for name, kind in columns)
        connection.execute(f"CREATE TABLE IF NOT EXISTS {table} ({rendered})")


def row(table: str, **values: Any) -> tuple:
    """Return a tuple in column order; unnamed columns are NULL."""
    names = [name for name, _ in COLUMNS[table]]
    unknown = set(values) - set(names)
    if unknown:
        raise KeyError(f"{table} has no columns {sorted(unknown)}")
    return tuple(values.get(name) for name in names)


try:  # pyarrow turns a row batch into one bulk insert; executemany is the slow fallback
    import pyarrow as _pa
except ImportError:  # pragma: no cover - depends on the overlay environment
    _pa = None

_ARROW_TYPES = {
    "VARCHAR": lambda: _pa.string(),
    "BIGINT": lambda: _pa.int64(),
    "INTEGER": lambda: _pa.int32(),
    "DOUBLE": lambda: _pa.float64(),
    "BOOLEAN": lambda: _pa.bool_(),
    "TIMESTAMP": lambda: _pa.timestamp("us"),
}


def insert(connection: Any, table: str, rows: list[tuple]) -> int:
    """Insert rows as one Arrow batch when pyarrow is present, else statement by statement."""
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
    """Epoch milliseconds (or seconds when small) to naive UTC."""
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
    """ISO-8601 text such as ``2026-10-06T13:30:29.834Z`` to naive UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed
