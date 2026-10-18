"""Scaffolding shared by the ingesters: provenance, run summary, staging, publishing, compaction.

A run scans its source for units (one transcript file each), asks the target's ledger which units
changed, parses only those into a staging database, and publishes them into the target by replacing
each changed thread's rows inside one transaction. The target is a local DuckDB file or a
MotherDuck database; the same path serves both. Lineage is then recomputed from the store, see
:mod:`pdum.agent_history.derive`.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import platform
import socket
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import duckdb
import platformdirs

from . import ledger as ledger_module
from . import schema
from .targets import Target, ensure_schema

DEFAULT_WINDOW_DAYS = 183
"""Roughly six months; older history is counted, not modelled."""

THREAD_KEYED_TABLES = (
    "threads",
    "turns",
    "responses",
    "token_counts",
    "items",
    "item_blobs",
    "rollout_events",
    "response_items",
    "coverage",
    "thread_links",
)
"""Tables whose rows belong to one thread and are replaced with it."""

CHILD_KEYED_TABLES = ("spawn_edges", "fork_edges")
"""Tables keyed by the child thread; the child's rows are replaced with it."""


def ingester_version() -> str:
    """Return the installed distribution version, or ``dev`` from a source checkout."""
    try:
        return package_version("habemus-papadum-agent-history")
    except PackageNotFoundError:  # pragma: no cover - depends on the environment
        return "dev"


def host_identity(state_dir: Path | None = None) -> dict[str, str]:
    """Return this machine's stable identity, minting ``host_id`` on first use.

    A hostname is a label, never a key: machines get renamed and a rename would fork one
    machine's history into two. The id is minted once and kept under the launcher's own data
    directory, never inside an agent's home, and the hostname rides along as a label that may
    change. ``PDUM_AGENT_HISTORY_HOST_ID`` overrides the stored id, for tests and containers.

    Parameters
    ----------
    state_dir : Path or None
        Directory holding ``host.json``; defaults to the platform user data directory.

    Returns
    -------
    dict
        ``host_id``, ``hostname``, ``platform`` and ``created_at``.
    """
    hostname = socket.gethostname()
    system = f"{platform.system().lower()} {platform.release()}"
    override = os.environ.get("PDUM_AGENT_HISTORY_HOST_ID")
    if override:
        return {"host_id": override, "hostname": hostname, "platform": system, "created_at": ""}
    directory = state_dir or platformdirs.user_data_path("pdum-agent-history", appauthor=False)
    path = directory / "host.json"
    stored: dict[str, str] = {}
    try:
        stored = json.loads(path.read_text())
    except (OSError, ValueError):
        stored = {}
    identity = {
        "host_id": stored.get("host_id") or uuid.uuid4().hex,
        "hostname": hostname,
        "platform": system,
        "created_at": stored.get("created_at") or datetime.now(UTC).isoformat(),
    }
    if identity != stored:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(identity, indent=2) + "\n")
        except OSError:  # pragma: no cover - read-only home
            pass
    return identity


def assign_lineage(threads: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Fill ``lineage_id`` and ``lineage_depth`` on every thread record from its predecessor chain.

    A thread's predecessor is ``forked_from_id`` (the session it continued or forked from) or, for
    a sub-agent, ``parent_thread_id``. The root of the chain is the lineage id and the hop count is
    the depth. A chain that leaves the corpus ends at the missing predecessor, which still names the
    lineage so siblings of a deleted session stay together; a cycle breaks at its first repeat.

    Parameters
    ----------
    threads : dict
        Thread records by id, updated in place.

    Returns
    -------
    dict
        ``{thread_id: reason}`` for chains that cycled.
    """
    notes: dict[str, str] = {}
    memo: dict[str, tuple[str, int]] = {}

    def resolve(thread_id: str, seen: tuple[str, ...]) -> tuple[str, int]:
        if thread_id in memo:
            return memo[thread_id]
        record = threads.get(thread_id)
        if record is None:
            return thread_id, 0
        predecessor = record.get("forked_from_id") or record.get("parent_thread_id")
        if not predecessor or predecessor == thread_id:
            result = (thread_id, 0)
        elif predecessor in seen:
            notes[thread_id] = f"lineage of {thread_id} cycles through {predecessor}"
            result = (thread_id, 0)
        else:
            root, depth = resolve(predecessor, (*seen, thread_id))
            result = (root, depth + 1)
        memo[thread_id] = result
        return result

    for thread_id, record in threads.items():
        root, depth = resolve(thread_id, ())
        record["lineage_id"] = root
        record["lineage_depth"] = depth
    return notes


def repo_from_origin(origin: str | None) -> str | None:
    """Normalize a git remote URL to ``owner/name`` when it has that shape.

    Parameters
    ----------
    origin : str or None
        ``https://host/owner/name.git``, ``git@host:owner/name.git`` or similar.

    Returns
    -------
    str or None
        The last two path segments without ``.git``; one segment when that is all there is.
    """
    if not origin:
        return None
    text = origin.strip()
    if "://" in text:
        path = urlparse(text).path
    elif ":" in text and "@" in text.split(":", 1)[0]:
        path = text.split(":", 1)[1]
    else:
        path = text
    parts = [part for part in path.strip("/").split("/") if part]
    if not parts:
        return None
    parts[-1] = parts[-1].removesuffix(".git")
    return "/".join(parts[-2:])


@dataclass
class IngestSummary:
    """What one ingest run read and wrote.

    Parameters
    ----------
    run_id : str
        Identifier shared by the run's ``ingest_runs`` rows.
    source : str
        The ``source`` value written to every row.
    source_id : str
        Provenance key written to every row; stable for one agent, machine and root.
    root : str
        Directory that was read.
    target : str
        Where rows were published: a file path or ``md:<database>``.
    mode : str
        ``rebuild`` for a fresh local file, ``sync`` for an incremental run, ``full`` for a sync
        that re-read every unit.
    window_cutoff : str or None
        ISO timestamp before which threads are only counted, or None when unlimited.
    """

    run_id: str
    source: str
    source_id: str
    root: str
    target: str
    mode: str
    window_cutoff: str | None
    label: str = ""
    host: dict[str, str] = field(default_factory=dict)
    units: dict[str, int] = field(default_factory=dict)
    phases: dict[str, dict[str, Any]] = field(default_factory=dict)
    tables: dict[str, int] = field(default_factory=dict)
    derived: dict[str, Any] = field(default_factory=dict)
    unknown_line_types: dict[str, int] = field(default_factory=dict)
    ignored_line_types: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    db_bytes: int = 0
    total_seconds: float = 0.0

    @property
    def db_path(self) -> str:
        """The target spec, kept under its old name for callers that printed it."""
        return self.target

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible dictionary."""
        return asdict(self)


def compact(db_path: Path) -> None:
    """Rewrite a freshly written DuckDB file without the free blocks bulk inserts leave behind.

    Parameters
    ----------
    db_path : Path
        Database to compact in place; a sibling temporary file is written and renamed over it.
    """
    temporary = db_path.with_name(f".{db_path.name}.compact")
    temporary.unlink(missing_ok=True)
    connection = duckdb.connect(str(temporary))
    try:
        target = connection.execute("select current_database()").fetchone()[0]
        connection.execute(f"ATTACH '{db_path}' AS source (READ_ONLY)")
        connection.execute(f'COPY FROM DATABASE source TO "{target}"')
        connection.execute("CHECKPOINT")
    finally:
        connection.close()
    os.replace(temporary, db_path)


class BaseIngest:
    """Common run scaffolding for one source into one target.

    Parameters
    ----------
    source : str
        The ``source`` value written to every row, such as ``codex-fs``.
    agent : str
        Agent kind recorded in provenance, ``codex`` or ``claude``.
    root : Path
        Directory to read.
    target : Target or Path or str
        Where to publish: a local DuckDB file or ``md:<database>``.
    window_days : int or None
        Threads anchored before ``now - window_days`` are counted, not modelled. None disables.
    blobs : bool
        Store full item JSON in ``item_blobs``.
    now : datetime or None
        Reference time for the window; defaults to the current UTC time.
    host : dict or None
        Host identity; defaults to :func:`host_identity`.
    mode : str
        ``rebuild`` replaces a local file outright (the default of ``pdum-history ingest``);
        ``sync`` replaces only the threads whose files changed since the ledger was written;
        ``full`` is a sync that re-reads every unit, used after a schema change.
    """

    def __init__(
        self,
        source: str,
        agent: str,
        root: Path,
        target: Target | Path | str,
        *,
        window_days: int | None = DEFAULT_WINDOW_DAYS,
        blobs: bool = True,
        now: datetime | None = None,
        host: dict[str, str] | None = None,
        mode: str = "rebuild",
    ) -> None:
        if mode not in {"rebuild", "sync", "full"}:
            raise ValueError(f"unknown mode {mode!r}")
        self.source = source
        self.agent = agent
        self.root = root.expanduser().resolve()
        self.target = target if isinstance(target, Target) else Target(str(target))
        if mode == "rebuild" and self.target.motherduck:
            mode = "full"
        self.mode = mode
        self.blobs = blobs
        reference = now or datetime.now(UTC).replace(tzinfo=None)
        self.cutoff = reference - timedelta(days=window_days) if window_days is not None else None
        self.run_id = uuid.uuid4().hex[:12]
        self.host = host or host_identity()
        root_hash = hashlib.sha1(str(self.root).encode()).hexdigest()[:8]
        self.source_id = f"{agent}-{self.host['host_id'][:8]}-{root_hash}"
        self.versions: set[str] = set()
        self.summary = IngestSummary(
            run_id=self.run_id,
            source=source,
            source_id=self.source_id,
            root=str(self.root),
            target=self.target.spec,
            mode=mode,
            window_cutoff=self.cutoff.isoformat() if self.cutoff else None,
            host={k: v for k, v in self.host.items() if k != "created_at"},
        )
        self.coverage: dict[str, dict[str, Any]] = {}
        self.unit_threads: dict[str, list[str]] = {}
        """Thread ids each unit produced this run, for the ledger and for later replacement."""
        self.con: duckdb.DuckDBPyConnection | None = None
        self._source_index = {
            table: [index for index, (name, _) in enumerate(columns) if name == "source_id"]
            for table, columns in schema.COLUMNS.items()
        }

    # ---------------------------------------------------------------- helpers
    @property
    def db_path(self) -> Path:
        """The local target file; raises for MotherDuck targets."""
        return self.target.path

    def in_window(self, moment: datetime | None) -> bool:
        """Return whether a thread anchored at ``moment`` is modelled."""
        if self.cutoff is None:
            return True
        return moment is not None and moment >= self.cutoff

    def connection(self) -> duckdb.DuckDBPyConnection:
        assert self.con is not None, "run() opens the database"
        return self.con

    def write(self, table: str, rows: list[tuple]) -> int:
        """Insert rows, stamping this run's ``source_id`` where the row left it empty."""
        positions = self._source_index.get(table) or []
        if positions and rows:
            index = positions[0]
            rows = [
                row if row[index] is not None else row[:index] + (self.source_id,) + row[index + 1 :] for row in rows
            ]
        return schema.insert(self.connection(), table, rows)

    def phase(self, name: str, started: float, rows: int, detail: str = "") -> None:
        """Record one phase's timing in the summary and in ``ingest_runs``."""
        seconds = time.perf_counter() - started
        self.summary.phases[name] = {"seconds": round(seconds, 3), "rows": rows, "detail": detail}
        self.write(
            "ingest_runs",
            [
                schema.row(
                    "ingest_runs",
                    run_id=self.run_id,
                    source=self.source,
                    phase=name,
                    started_at=datetime.now(UTC).replace(tzinfo=None),
                    seconds=seconds,
                    rows=rows,
                    detail=detail,
                )
            ],
        )

    def cover(self, thread_id: str) -> dict[str, Any]:
        """Return the mutable coverage record for a thread, creating it on first use."""
        return self.coverage.setdefault(
            thread_id,
            {
                "thread_id": thread_id,
                "in_window": True,
                "in_catalogue": False,
                "in_projection": False,
                "rollout_format": None,
                "rollout_lines": 0,
                "turn_contexts": 0,
                "usage_records": 0,
                "token_counts": 0,
                "projection_turns": 0,
                "projection_items": 0,
                "rollout_item_completed": 0,
                "response_items": 0,
                "compactions": 0,
                "unknown_line_types": 0,
                "marker_lines": 0,
            },
        )

    def unknown(self, kind: str) -> None:
        self.summary.unknown_line_types[kind] = self.summary.unknown_line_types.get(kind, 0) + 1

    def ignored(self, kind: str) -> None:
        self.summary.ignored_line_types[kind] = self.summary.ignored_line_types.get(kind, 0) + 1

    def write_coverage_and_meta(self, extra_meta: dict[str, str] | None = None) -> int:
        """Write ``coverage``, ``provenance`` and ``meta`` rows; return the number of coverage rows."""
        cover_rows = [
            schema.row("coverage", **cover, source=self.source, origin=f"ingest-{self.source}")
            for cover in self.coverage.values()
        ]
        self.write("coverage", cover_rows)
        now = datetime.now(UTC).replace(tzinfo=None)
        self.write(
            "provenance",
            [
                schema.row(
                    "provenance",
                    source_id=self.source_id,
                    host_id=self.host["host_id"],
                    hostname=self.host.get("hostname"),
                    os_user=getpass.getuser(),
                    platform=self.host.get("platform"),
                    agent=self.agent,
                    root=str(self.root),
                    agent_versions=json.dumps(sorted(self.versions)),
                    window_cutoff=self.cutoff,
                    schema_version=schema.SCHEMA_VERSION,
                    ingester_version=ingester_version(),
                    ingested_at=now,
                    run_id=self.run_id,
                )
            ],
        )
        meta = {
            "schema_version": str(schema.SCHEMA_VERSION),
            "last_run_id": self.run_id,
            "last_ingested_at": now.isoformat(),
            **(extra_meta or {}),
        }
        self.write("meta", [schema.row("meta", key=key, value=value) for key, value in meta.items()])
        return len(cover_rows)

    # -------------------------------------------------------------------- run
    def run(self) -> IngestSummary:
        """Scan, plan, ingest the changed units, publish, derive lineage and return the summary."""
        total = time.perf_counter()
        scan = self.scan()
        if self.mode == "rebuild":
            self._rebuild(scan)
        else:
            self._sync(scan)
        self.summary.total_seconds = round(time.perf_counter() - total, 3)
        return self.summary

    def _rebuild(self, scan: dict[str, ledger_module.Unit]) -> None:
        """Write a fresh local file directly, then compact it."""
        from .derive import dedupe_responses, derive_lineage

        path = self.db_path
        if path.exists():
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        plan = ledger_module.plan(scan, {}, full=True)
        self.summary.units = plan.counts
        self.con = duckdb.connect(str(path))
        try:
            schema.create(self.con)
            self.ingest(plan.changed)
            now = datetime.now(UTC).replace(tzinfo=None)
            self.write(
                "ingest_ledger", ledger_module.rows(self.source_id, self.run_id, plan, {}, self.unit_threads, now)
            )
            self.summary.derived = derive_lineage(self.con, self.source_id, self.source)
            self.summary.derived["deduplicated"] = dedupe_responses(self.con, self.source_id)
            self.summary.notes.extend(self.summary.derived.get("notes", []))
            self.summary.tables = {
                table: self.con.execute(f"select count(*) from {table}").fetchone()[0] for table in schema.COLUMNS
            }
            self.con.execute("CHECKPOINT")
        finally:
            self.con.close()
            self.con = None
        compact(path)
        self.summary.db_bytes = path.stat().st_size

    def _sync(self, scan: dict[str, ledger_module.Unit]) -> None:
        """Parse changed units into a staging file and publish them into the target."""
        target_con = self.target.connect()
        try:
            ensure_schema(target_con, rebuild=self.mode == "full")
            stored = ledger_module.read(target_con, self.source_id)
            self.prepare(target_con)
        finally:
            target_con.close()
        plan = ledger_module.plan(scan, stored, full=self.mode == "full")
        self.summary.units = plan.counts
        staging_dir = Path(tempfile.mkdtemp(prefix="pdum-history-"))
        staging = staging_dir / "staging.duckdb"
        self.con = duckdb.connect(str(staging))
        try:
            schema.create(self.con)
            self.ingest(plan.changed)
            now = datetime.now(UTC).replace(tzinfo=None)
            self.write(
                "ingest_ledger", ledger_module.rows(self.source_id, self.run_id, plan, stored, self.unit_threads, now)
            )
            self.summary.tables = {
                table: self.con.execute(f"select count(*) from {table}").fetchone()[0] for table in schema.COLUMNS
            }
            self.con.execute("CHECKPOINT")
        finally:
            self.con.close()
            self.con = None
        try:
            self.publish(staging, plan, stored)
        finally:
            staging.unlink(missing_ok=True)
            staging.with_name(staging.name + ".wal").unlink(missing_ok=True)
            try:
                staging_dir.rmdir()
            except OSError:  # pragma: no cover - leftover temp files
                pass

    def publish(self, staging: Path, plan: ledger_module.Plan, stored: dict[str, ledger_module.LedgerRow]) -> None:
        """Replace the changed threads' rows in the target with the staged rows, then derive lineage."""
        from .derive import dedupe_responses, derive_lineage

        started = time.perf_counter()
        replaced: set[str] = set()
        for unit_id in plan.changed:
            replaced.update(self.unit_threads.get(unit_id) or [unit_id])
            row = stored.get(unit_id)
            if row is not None:
                replaced.update(row.thread_ids)
        con = self.target.connect()
        alias = f"staging_{self.run_id}"
        try:
            # MotherDuck remembers attachments across sessions, so never reuse a name and always detach.
            con.execute(f"DETACH DATABASE IF EXISTS {alias}")
            con.execute(f"ATTACH '{staging}' AS {alias} (READ_ONLY)")
            con.execute("BEGIN TRANSACTION")
            con.execute("CREATE TEMP TABLE _replaced (thread_id VARCHAR)")
            if replaced:
                con.executemany("INSERT INTO _replaced VALUES (?)", [(thread_id,) for thread_id in sorted(replaced)])
            for table in THREAD_KEYED_TABLES:
                con.execute(
                    f"DELETE FROM {table} WHERE source_id = ? AND thread_id IN (SELECT thread_id FROM _replaced)",
                    [self.source_id],
                )
            for table in CHILD_KEYED_TABLES:
                con.execute(
                    f"DELETE FROM {table} WHERE source_id = ? AND child_thread_id IN (SELECT thread_id FROM _replaced)",
                    [self.source_id],
                )
            if self.mode == "full":
                con.execute("DELETE FROM logs WHERE source_id = ?", [self.source_id])
            con.execute("DELETE FROM provenance WHERE source_id = ?", [self.source_id])
            con.execute(f"DELETE FROM meta WHERE key IN (SELECT key FROM {alias}.meta)")
            touched_units = sorted({*plan.changed, *plan.gone})
            if touched_units:
                con.execute("CREATE TEMP TABLE _units (unit_id VARCHAR)")
                con.executemany("INSERT INTO _units VALUES (?)", [(unit_id,) for unit_id in touched_units])
                con.execute(
                    "DELETE FROM ingest_ledger WHERE source_id = ? AND unit_id IN (SELECT unit_id FROM _units)",
                    [self.source_id],
                )
            for table in schema.COLUMNS:
                con.execute(f"INSERT INTO {table} SELECT * FROM {alias}.{table}")
            deduplicated = dedupe_responses(con, self.source_id)
            con.execute("COMMIT")
            self.summary.derived = derive_lineage(con, self.source_id, self.source)
            self.summary.derived["deduplicated"] = deduplicated
            self.summary.notes.extend(self.summary.derived.get("notes", []))
            if not self.target.motherduck:
                con.execute("CHECKPOINT")
                self.summary.db_bytes = self.db_path.stat().st_size
        except Exception:
            try:
                con.execute("ROLLBACK")
            except duckdb.Error:  # pragma: no cover - nothing to roll back
                pass
            raise
        finally:
            try:
                con.execute(f"DETACH DATABASE IF EXISTS {alias}")
            except duckdb.Error:  # pragma: no cover - connection already unusable
                pass
            con.close()
        self.summary.phases["publish"] = {
            "seconds": round(time.perf_counter() - started, 3),
            "rows": sum(self.summary.tables.values()),
            "detail": f"threads replaced {len(replaced)}; units gone {len(plan.gone)}",
        }

    # ------------------------------------------------------------- subclasses
    def scan(self) -> dict[str, ledger_module.Unit]:  # pragma: no cover - subclasses implement
        """Return every unit the source holds, keyed by unit id, from file metadata alone."""
        raise NotImplementedError

    def prepare(self, target: duckdb.DuckDBPyConnection) -> None:
        """Read anything a sync needs from the target before parsing, such as a log watermark."""

    def ingest(self, units: dict[str, ledger_module.Unit]) -> None:  # pragma: no cover - subclasses implement
        """Parse the given units and write their rows."""
        raise NotImplementedError
