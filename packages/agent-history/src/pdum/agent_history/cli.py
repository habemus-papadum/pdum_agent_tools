"""``pdum-history``: ingest agent session history into DuckDB or MotherDuck."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from . import config as config_module
from . import schema
from .base import DEFAULT_WINDOW_DAYS, IngestSummary
from .claude import default_claude_dir, ingest_claude_dir
from .codex import default_codex_home, ingest_codex_home
from .sync import sync as run_sync
from .targets import TargetError

app = typer.Typer(help="Ingest Codex and Claude Code session history into DuckDB.", no_args_is_help=True)
ingest_app = typer.Typer(help="Read one agent's local history into a DuckDB file or MotherDuck database.")
app.add_typer(ingest_app, name="ingest")
console = Console()

DbOption = Annotated[
    str,
    typer.Option(
        "--db",
        help="DuckDB file or md:<database>. Without --sync a local file is replaced; md: targets always sync.",
    ),
]
WindowOption = Annotated[
    int, typer.Option("--window-days", help="Threads older than this are counted, not modelled; 0 disables.")
]
BlobsOption = Annotated[bool, typer.Option("--blobs/--no-blobs", help="Store full item JSON in item_blobs.")]
SyncOption = Annotated[
    bool, typer.Option("--sync", help="Replace only the threads whose files changed since the last run.")
]
FullOption = Annotated[bool, typer.Option("--full", help="With --sync or a config: re-read every file.")]
JsonOption = Annotated[bool, typer.Option("--json", help="Print the summary as JSON.")]


def _short(path: str) -> str:
    """Render a path with the home directory as ``~``."""
    home = str(Path.home())
    return f"~{path[len(home) :]}" if path.startswith(home) else path


def _mode(sync: bool, full: bool) -> str:
    if full:
        return "full"
    return "sync" if sync else "rebuild"


def _report(summary: IngestSummary, as_json: bool) -> None:
    if as_json:
        typer.echo(json.dumps(summary.to_dict(), indent=2, default=str))
        return
    table = Table(title=f"{summary.source} → {summary.target} ({summary.mode})")
    table.add_column("Phase")
    table.add_column("Seconds", justify="right")
    table.add_column("Rows", justify="right")
    table.add_column("Detail")
    for name, phase in summary.phases.items():
        table.add_row(name, f"{phase['seconds']:.2f}", str(phase["rows"]), phase["detail"])
    console.print(table)
    counts = Table(title="Rows written")
    counts.add_column("Table")
    counts.add_column("Rows", justify="right")
    for name, count in summary.tables.items():
        if count:
            counts.add_row(name, str(count))
    console.print(counts)
    window = summary.window_cutoff or "unlimited"
    size = f"; database {summary.db_bytes / 1e6:.0f} MB" if summary.db_bytes else ""
    console.print(f"units {summary.units}; window cutoff {window}{size}; {summary.total_seconds:.1f} s")
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
    sync: SyncOption = False,
    full: FullOption = False,
    as_json: JsonOption = False,
) -> None:
    """Read a Codex home read-only into a DuckDB file or MotherDuck database."""
    try:
        summary = ingest_codex_home(
            home or default_codex_home(), db, window_days=window_days or None, blobs=blobs, mode=_mode(sync, full)
        )
    except TargetError as error:
        raise typer.BadParameter(str(error)) from error
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
    sync: SyncOption = False,
    full: FullOption = False,
    as_json: JsonOption = False,
) -> None:
    """Read a Claude Code configuration directory read-only into a DuckDB file or MotherDuck database."""
    try:
        summary = ingest_claude_dir(
            claude_dir or default_claude_dir(),
            db,
            window_days=window_days or None,
            blobs=blobs,
            mode=_mode(sync, full),
        )
    except TargetError as error:
        raise typer.BadParameter(str(error)) from error
    _report(summary, as_json)


@app.command("sync")
def sync_command(
    config_path: Annotated[
        Path | None,
        typer.Option(
            "--config", help="Configuration file; defaults to $PDUM_AGENT_HISTORY_CONFIG or the user config dir."
        ),
    ] = None,
    target: Annotated[
        list[str] | None, typer.Option("--target", help="Only these target names; repeatable. Default: all.")
    ] = None,
    full: FullOption = False,
    example: Annotated[bool, typer.Option("--example", help="Print an example configuration and exit.")] = False,
    as_json: JsonOption = False,
) -> None:
    """Sync every configured source (Codex homes, Claude directories, launcher profiles) into every target."""
    if example:
        typer.echo(config_module.EXAMPLE, nl=False)
        return
    try:
        config = config_module.load(config_path)
        summaries = run_sync(config, targets=target, full=full)
    except (config_module.ConfigError, TargetError) as error:
        raise typer.BadParameter(str(error)) from error
    if as_json:
        typer.echo(json.dumps([summary.to_dict() for summary in summaries], indent=2, default=str))
        return
    table = Table(title=f"sync from {_short(str(config.path))}")
    numeric = {"Changed", "Unchanged", "Gone", "Threads", "Seconds"}
    for column in ("Target", "Agent", "Source", "Mode", "Changed", "Unchanged", "Gone", "Threads", "Seconds"):
        table.add_column(column, justify="right" if column in numeric else "left")
    labels = {target.spec: target.label for target in config.targets}
    for summary in summaries:
        units = summary.units
        table.add_row(
            labels.get(summary.target, summary.target),
            summary.source.split("-")[0],
            _short(summary.root) if summary.label in {"home", "dir", ""} else summary.label,
            summary.mode,
            str(units.get("changed", 0)),
            str(units.get("unchanged", 0)),
            str(units.get("gone", 0)),
            str(summary.tables.get("threads", 0)),
            f"{summary.total_seconds:.1f}",
        )
    console.print(table)
    for note in config.notes:
        console.print(f"note: {note}")
    for summary in summaries:
        for note in summary.notes:
            console.print(f"note ({summary.label or summary.source}): {note}")
        if summary.unknown_line_types:
            console.print(f"unknown line types ({summary.label or summary.source}): {summary.unknown_line_types}")


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
