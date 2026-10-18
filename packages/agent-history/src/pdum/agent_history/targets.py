"""Where a run's rows end up: a local DuckDB file or a MotherDuck database.

A target is named by a string: a filesystem path, or ``md:<database>`` for MotherDuck. The
MotherDuck token comes from the environment (``MOTHERDUCK_TOKEN``, else ``motherduck_token``, else
the variable a target names), never from a file this package writes. Every run first writes into a
staging database and then publishes into the target through one connection that sees both, so the
same code path serves both kinds of target.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import duckdb

from . import schema

MOTHERDUCK_PREFIX = "md:"
TOKEN_VARIABLES = ("MOTHERDUCK_TOKEN", "motherduck_token")


class TargetError(RuntimeError):
    """The target cannot be used as asked, for example because its schema version differs."""


@dataclass(frozen=True)
class Target:
    """One place rows are published to.

    Parameters
    ----------
    spec : str
        A filesystem path or ``md:<database>``.
    name : str
        Short label used in output; defaults to the spec.
    token_env : str or None
        Environment variable holding the MotherDuck token when it is not one of the defaults.
    """

    spec: str
    name: str = ""
    token_env: str | None = None

    @property
    def label(self) -> str:
        return self.name or self.spec

    @property
    def motherduck(self) -> bool:
        return self.spec.startswith(MOTHERDUCK_PREFIX)

    @property
    def path(self) -> Path:
        """The local file, for filesystem targets."""
        if self.motherduck:
            raise TargetError(f"{self.spec} is not a local file")
        return Path(self.spec).expanduser().resolve()

    def token(self) -> str | None:
        """Return the MotherDuck token from the environment, or None when unset."""
        names = (*((self.token_env,) if self.token_env else ()), *TOKEN_VARIABLES)
        for name in names:
            value = os.environ.get(name)
            if value:
                return value
        return None

    def connect(self) -> duckdb.DuckDBPyConnection:
        """Open a read-write connection to the target, creating a local file when absent."""
        if self.motherduck:
            spec = self.spec if "?" in self.spec else f"{self.spec}?attach_mode=single"
            config = {"motherduck_token": self.token()} if self.token() else {}
            try:
                return duckdb.connect(spec, config=config)
            except duckdb.Error as error:
                raise TargetError(f"cannot connect to {self.spec}: {error}") from error
        self.path.parent.mkdir(parents=True, exist_ok=True)
        return duckdb.connect(str(self.path))


def schema_version(connection: duckdb.DuckDBPyConnection) -> int | None:
    """Return the schema version a database declares in ``meta``, or None when it has none."""
    tables = {row[0] for row in connection.execute("select table_name from duckdb_tables()").fetchall()}
    if "meta" not in tables:
        return None
    row = connection.execute("select value from meta where key = 'schema_version'").fetchone()
    return int(row[0]) if row and row[0] is not None else None


def ensure_schema(connection: duckdb.DuckDBPyConnection, *, rebuild: bool) -> None:
    """Create the tables and views, or replace them when the version differs and a rebuild is allowed.

    Parameters
    ----------
    connection : duckdb.DuckDBPyConnection
        Open connection to the target database.
    rebuild : bool
        Drop and recreate every table of this schema when the stored version differs. Tables that
        are not part of the schema, such as a ``tagsdb`` schema holding annotations, are left alone.

    Raises
    ------
    TargetError
        When the stored version differs and ``rebuild`` is false.
    """
    stored = schema_version(connection)
    if stored is not None and stored != schema.SCHEMA_VERSION:
        if not rebuild:
            raise TargetError(
                f"target holds schema version {stored}, this ingester writes {schema.SCHEMA_VERSION}; "
                "run with --full to rebuild it"
            )
        for view in schema.VIEWS:
            connection.execute(f"DROP VIEW IF EXISTS {view}")
        for table in schema.COLUMNS:
            connection.execute(f"DROP TABLE IF EXISTS {table}")
    schema.create(connection)
