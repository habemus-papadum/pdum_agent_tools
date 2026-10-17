"""Scaffolding shared by the ingesters: provenance, run summary, phases, coverage and compaction."""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import platform
import socket
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

from . import schema

DEFAULT_WINDOW_DAYS = 183
"""Roughly six months; older history is counted, not modelled."""


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
    db_path : str
        DuckDB file that was written.
    window_cutoff : str or None
        ISO timestamp before which threads are only counted, or None when unlimited.
    """

    run_id: str
    source: str
    source_id: str
    root: str
    db_path: str
    window_cutoff: str | None
    host: dict[str, str] = field(default_factory=dict)
    phases: dict[str, dict[str, Any]] = field(default_factory=dict)
    tables: dict[str, int] = field(default_factory=dict)
    unknown_line_types: dict[str, int] = field(default_factory=dict)
    ignored_line_types: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    db_bytes: int = 0
    total_seconds: float = 0.0

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
    """Common run scaffolding for one ingest into a fresh DuckDB file.

    Parameters
    ----------
    source : str
        The ``source`` value written to every row, such as ``codex-fs``.
    agent : str
        Agent kind recorded in provenance, ``codex`` or ``claude``.
    root : Path
        Directory to read.
    db_path : Path
        DuckDB file to create; an existing file is replaced.
    window_days : int or None
        Threads anchored before ``now - window_days`` are counted, not modelled. None disables.
    blobs : bool
        Store full item JSON in ``item_blobs``.
    now : datetime or None
        Reference time for the window; defaults to the current UTC time.
    host : dict or None
        Host identity; defaults to :func:`host_identity`.
    """

    def __init__(
        self,
        source: str,
        agent: str,
        root: Path,
        db_path: Path,
        *,
        window_days: int | None = DEFAULT_WINDOW_DAYS,
        blobs: bool = True,
        now: datetime | None = None,
        host: dict[str, str] | None = None,
    ) -> None:
        self.source = source
        self.agent = agent
        self.root = root.expanduser().resolve()
        self.db_path = db_path.expanduser().resolve()
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
            db_path=str(self.db_path),
            window_cutoff=self.cutoff.isoformat() if self.cutoff else None,
            host={k: v for k, v in self.host.items() if k != "created_at"},
        )
        self.coverage: dict[str, dict[str, Any]] = {}
        self.con: duckdb.DuckDBPyConnection | None = None
        self._source_index = {
            table: [index for index, (name, _) in enumerate(columns) if name == "source_id"]
            for table, columns in schema.COLUMNS.items()
        }

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
            "run_id": self.run_id,
            "source": self.source,
            "source_id": self.source_id,
            "root": str(self.root),
            "window_cutoff": self.summary.window_cutoff or "",
            "ingested_at": now.isoformat(),
            **(extra_meta or {}),
        }
        self.write("meta", [schema.row("meta", key=key, value=value) for key, value in meta.items()])
        return len(cover_rows)

    def run(self) -> IngestSummary:
        """Open the database, run :meth:`ingest`, compact the file and return the summary."""
        total = time.perf_counter()
        if self.db_path.exists():
            self.db_path.unlink()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect(str(self.db_path))
        try:
            schema.create(self.con)
            self.ingest()
            self.summary.tables = {
                table: self.con.execute(f"select count(*) from {table}").fetchone()[0] for table in schema.COLUMNS
            }
            self.con.execute("CHECKPOINT")
        finally:
            self.con.close()
            self.con = None
        compact(self.db_path)
        self.summary.db_bytes = self.db_path.stat().st_size
        self.summary.total_seconds = round(time.perf_counter() - total, 3)
        return self.summary

    def ingest(self) -> None:  # pragma: no cover - subclasses implement
        raise NotImplementedError
