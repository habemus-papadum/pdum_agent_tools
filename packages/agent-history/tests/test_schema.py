"""The schema contract and its copy in the TypeScript package."""

import json
from pathlib import Path

import duckdb
from pdum.agent_history import schema

TYPESCRIPT_COPY = (
    Path(__file__).resolve().parents[3] / "typescript/packages/agent-history/schema/agent-history.schema.json"
)


def test_ddl_creates_every_table_and_view_in_memory():
    con = duckdb.connect()
    schema.create(con)
    tables = {row[0] for row in con.execute("select table_name from information_schema.tables").fetchall()}
    assert set(schema.COLUMNS) <= tables
    views = {row[0] for row in con.execute("select view_name from duckdb_views() where not internal").fetchall()}
    assert set(schema.VIEWS) <= views
    con.execute("select * from usage_events").fetchall()


def test_row_rejects_unknown_columns_and_orders_values():
    values = schema.row("meta", value="v", key="k")
    assert values == ("k", "v")
    try:
        schema.row("meta", nope=1)
    except KeyError as error:
        assert "nope" in str(error)
    else:  # pragma: no cover
        raise AssertionError("unknown column accepted")


def test_typescript_copy_matches_the_python_contract():
    """Regenerate the copy with ``pdum-history schema --json`` redirected to the TypeScript schema file."""
    assert TYPESCRIPT_COPY.exists(), f"missing {TYPESCRIPT_COPY}"
    assert json.loads(TYPESCRIPT_COPY.read_text()) == schema.describe()
