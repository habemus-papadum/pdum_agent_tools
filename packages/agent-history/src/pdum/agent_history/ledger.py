"""What a source's files looked like when they were last read, so a run can do only the new work.

The unit of incremental work is one transcript file: a Claude session or sub-agent file, a Codex
rollout with its catalogue row. Files are append-only, so size, modification time and a small
fingerprint (the catalogue's ``updated_at`` for Codex) decide whether a unit changed. A unit whose
file has vanished is marked ``gone`` and its rows stay: the agents' own stores forget, this one does
not. Removing history is an explicit command, never a side effect of a run.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb

from . import schema

PRESENT = "present"
GONE = "gone"


@dataclass
class Unit:
    """One file as found on disk during a scan.

    Parameters
    ----------
    unit_id : str
        Stable id, the thread id the file is about (``session`` or ``session:agent``).
    path : Path or None
        The file; None for a catalogue-only Codex thread without a rollout.
    bytes : int
        File size.
    mtime : datetime or None
        Modification time as naive UTC.
    fingerprint : str or None
        Extra change signal, such as the catalogue's ``updated_at`` for Codex threads.
    extra : dict
        Anything the ingester needs later, such as a sub-agent file's parent session.
    """

    unit_id: str
    path: Path | None
    bytes: int = 0
    mtime: datetime | None = None
    fingerprint: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_path(cls, unit_id: str, path: Path, fingerprint: str | None = None, **extra: Any) -> Unit:
        stat = path.stat()
        return cls(
            unit_id,
            path,
            bytes=stat.st_size,
            mtime=datetime.fromtimestamp(stat.st_mtime, tz=UTC).replace(tzinfo=None).replace(microsecond=0),
            fingerprint=fingerprint,
            extra=extra,
        )


@dataclass
class LedgerRow:
    """One stored ledger entry."""

    unit_id: str
    path: str | None
    bytes: int | None
    mtime: datetime | None
    fingerprint: str | None
    status: str
    thread_ids: list[str]
    first_seen_at: datetime | None


@dataclass
class Plan:
    """Which units a run reads, leaves alone or marks gone."""

    changed: dict[str, Unit]
    unchanged: dict[str, Unit]
    gone: dict[str, LedgerRow]

    @property
    def counts(self) -> dict[str, int]:
        return {"changed": len(self.changed), "unchanged": len(self.unchanged), "gone": len(self.gone)}


def read(connection: duckdb.DuckDBPyConnection, source_id: str) -> dict[str, LedgerRow]:
    """Return the stored ledger for one source, empty when the table is absent."""
    tables = {row[0] for row in connection.execute("select table_name from duckdb_tables()").fetchall()}
    if "ingest_ledger" not in tables:
        return {}
    rows = connection.execute(
        "select unit_id, path, bytes, mtime, fingerprint, status, thread_ids, first_seen_at "
        "from ingest_ledger where source_id = ?",
        [source_id],
    ).fetchall()
    return {
        row[0]: LedgerRow(row[0], row[1], row[2], row[3], row[4], row[5], json.loads(row[6] or "[]"), row[7])
        for row in rows
    }


def plan(scan: dict[str, Unit], ledger: dict[str, LedgerRow], *, full: bool) -> Plan:
    """Compare a scan with the ledger.

    Parameters
    ----------
    scan : dict
        Units found on disk, by id.
    ledger : dict
        Stored entries, by id.
    full : bool
        Treat every scanned unit as changed.
    """
    changed: dict[str, Unit] = {}
    unchanged: dict[str, Unit] = {}
    for unit_id, unit in scan.items():
        stored = ledger.get(unit_id)
        same = (
            stored is not None
            and stored.status == PRESENT
            and stored.bytes == unit.bytes
            and stored.mtime == unit.mtime
            and (stored.fingerprint or None) == (unit.fingerprint or None)
            and (stored.path or None) == (str(unit.path) if unit.path else None)
        )
        if full or not same:
            changed[unit_id] = unit
        else:
            unchanged[unit_id] = unit
    gone = {unit_id: row for unit_id, row in ledger.items() if unit_id not in scan and row.status == PRESENT}
    return Plan(changed, unchanged, gone)


def rows(
    source_id: str,
    run_id: str,
    plan_: Plan,
    ledger: dict[str, LedgerRow],
    thread_ids: dict[str, list[str]],
    now: datetime,
) -> list[tuple]:
    """Build the ledger rows a run writes: changed units as present, vanished units as gone.

    Parameters
    ----------
    thread_ids : dict
        Thread ids each changed unit produced, so a later replacement can delete exactly those.
    """
    out: list[tuple] = []
    for unit_id, unit in plan_.changed.items():
        stored = ledger.get(unit_id)
        out.append(
            schema.row(
                "ingest_ledger",
                source_id=source_id,
                unit_id=unit_id,
                path=str(unit.path) if unit.path else None,
                bytes=unit.bytes,
                mtime=unit.mtime,
                fingerprint=unit.fingerprint,
                status=PRESENT,
                thread_ids=json.dumps(thread_ids.get(unit_id) or [unit_id]),
                first_seen_at=(stored.first_seen_at if stored and stored.first_seen_at else now),
                last_seen_at=now,
                last_ingested_at=now,
                run_id=run_id,
            )
        )
    for unit_id, stored in plan_.gone.items():
        out.append(
            schema.row(
                "ingest_ledger",
                source_id=source_id,
                unit_id=unit_id,
                path=stored.path,
                bytes=stored.bytes,
                mtime=stored.mtime,
                fingerprint=stored.fingerprint,
                status=GONE,
                thread_ids=json.dumps(stored.thread_ids),
                first_seen_at=stored.first_seen_at,
                last_seen_at=stored.first_seen_at,
                last_ingested_at=None,
                run_id=run_id,
            )
        )
    return out
