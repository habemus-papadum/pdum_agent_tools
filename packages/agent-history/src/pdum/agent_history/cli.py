"""``pdum-history``: ingest agent session history into DuckDB."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from . import schema
from .base import DEFAULT_WINDOW_DAYS, IngestSummary
from .claude import default_claude_dir, ingest_claude_dir
from .codex import default_codex_home, ingest_codex_home

app = typer.Typer(help="Ingest Codex and Claude Code session history into DuckDB.", no_args_is_help=True)
ingest_app = typer.Typer(help="Read an agent's local history into a DuckDB file.", no_args_is_help=True)
app.add_typer(ingest_app, name="ingest")
console = Console()

DbOption = Annotated[Path, typer.Option("--db", help="DuckDB file to create; an existing file is replaced.")]
WindowOption = Annotated[
    int, typer.Option("--window-days", help="Threads older than this are counted, not modelled; 0 disables.")
]
BlobsOption = Annotated[bool, typer.Option("--blobs/--no-blobs", help="Store full item JSON in item_blobs.")]
JsonOption = Annotated[bool, typer.Option("--json", help="Print the summary as JSON.")]


def _report(summary: IngestSummary, as_json: bool) -> None:
    if as_json:
        typer.echo(json.dumps(summary.to_dict(), indent=2, default=str))
        return
    table = Table(title=f"{summary.source} → {summary.db_path}")
    table.add_column("Phase")
    table.add_column("Seconds", justify="right")
    table.add_column("Rows", justify="right")
    table.add_column("Detail")
    for name, phase in summary.phases.items():
        table.add_row(name, f"{phase['seconds']:.2f}", str(phase["rows"]), phase["detail"])
    console.print(table)
    counts = Table(title="Tables")
    counts.add_column("Table")
    counts.add_column("Rows", justify="right")
    for name, count in summary.tables.items():
        if count:
            counts.add_row(name, str(count))
    console.print(counts)
    window = summary.window_cutoff or "unlimited"
    console.print(f"window cutoff {window}; database {summary.db_bytes / 1e6:.0f} MB; {summary.total_seconds:.1f} s")
    if summary.unknown_line_types:
        console.print(f"unknown line types: {summary.unknown_line_types}")
    if summary.ignored_line_types:
        console.print(f"ignored line types: {summary.ignored_line_types}")
    for note in summary.notes:
        console.print(f"note: {note}")


@ingest_app.command("codex")
def ingest_codex(
    db: DbOption,
    home: Annotated[
        Path | None, typer.Option("--home", help="Codex home; defaults to $CODEX_HOME or ~/.codex.")
    ] = None,
    window_days: WindowOption = DEFAULT_WINDOW_DAYS,
    blobs: BlobsOption = True,
    as_json: JsonOption = False,
) -> None:
    """Read a Codex home read-only into a DuckDB file."""
    summary = ingest_codex_home(home or default_codex_home(), db, window_days=window_days or None, blobs=blobs)
    _report(summary, as_json)


@ingest_app.command("claude")
def ingest_claude(
    db: DbOption,
    claude_dir: Annotated[
        Path | None,
        typer.Option(
            "--claude-dir", help="Claude configuration directory; defaults to $CLAUDE_CONFIG_DIR or ~/.claude."
        ),
    ] = None,
    window_days: WindowOption = DEFAULT_WINDOW_DAYS,
    blobs: BlobsOption = True,
    as_json: JsonOption = False,
) -> None:
    """Read a Claude Code configuration directory read-only into a DuckDB file."""
    summary = ingest_claude_dir(claude_dir or default_claude_dir(), db, window_days=window_days or None, blobs=blobs)
    _report(summary, as_json)


@app.command("schema")
def show_schema(
    as_json: Annotated[bool, typer.Option("--json", help="Print the schema contract as JSON.")] = False,
) -> None:
    """Print the shared schema: tables, columns and views."""
    if as_json:
        typer.echo(schema.describe_json(), nl=False)
        return
    for table, columns in schema.COLUMNS.items():
        console.print(f"[bold]{table}[/bold]: " + ", ".join(f"{name} {kind}" for name, kind in columns))
    for view in schema.VIEWS:
        console.print(f"[bold]view {view}[/bold]")
    console.print(f"schema version {schema.SCHEMA_VERSION}")


if __name__ == "__main__":  # pragma: no cover
    app()
