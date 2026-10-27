"""Publish a TypeScript HP export through the existing staging/ledger writer.

This is a disposable source adapter, not a new ingestor configuration format.
Run with the repository root uv environment. It submits no model requests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from pdum.agent_history import schema
from pdum.agent_history.base import BaseIngest
from pdum.agent_history.ledger import Unit


class HpExportIngest(BaseIngest):
    """Read one complete exported HP source snapshot using existing ingest mechanics."""

    def __init__(self, source: Path, database: Path) -> None:
        self.path = source.resolve()
        self.payload = json.loads(self.path.read_text())
        if self.payload.get("format") != "hp-history-export" or self.payload.get("version") != 1:
            raise ValueError("Expected HP history export v1")
        if self.payload["rows"]["schemaVersion"] != schema.SCHEMA_VERSION:
            raise ValueError("HP export and production history schema differ")
        super().__init__(
            "hp-agent",
            "hp-agent",
            self.path.parent,
            database,
            mode="sync",
            host={"host_id": "spike-070", "hostname": "isolated-study", "platform": "portable-export"},
        )
        # Logical archive identity follows the data across storage backends.
        # A changed download/export path must not create another billable source.
        self.source_id = self.payload["sourceId"]
        if not isinstance(self.source_id, str) or not self.source_id:
            raise ValueError("Expected stable archive sourceId")
        self.summary.source_id = self.source_id
        self.versions.add("hp-session-archive-v1")

    def scan(self) -> dict[str, Unit]:
        """Return the complete archive as one unit, fingerprinted by content."""
        return {
            self.source_id: Unit.from_path(
                self.source_id, self.path, fingerprint=hashlib.sha256(self.path.read_bytes()).hexdigest()
            )
        }

    def ingest(self, units: dict[str, Unit]) -> None:
        """Validate column ownership and stage the changed archive's rows."""
        tables = self.payload["rows"]["tables"]
        forbidden = {"meta", "ingest_ledger", "ingest_runs", "provenance", "logs"}
        if units:
            for table, rows in tables.items():
                if not rows:
                    continue
                if table not in schema.COLUMNS or table in forbidden:
                    raise ValueError(f"HP export cannot write table {table}")
                columns = {name for name, _kind in schema.COLUMNS[table]}
                for row in rows:
                    if set(row) - columns:
                        raise ValueError(f"Unknown {table} columns: {sorted(set(row) - columns)}")
                    if row.get("source_id") != self.source_id or row.get("source") != self.source:
                        raise ValueError("HP row source identity differs from its archive")
                converted = []
                for row in rows:
                    row = dict(row)
                    for column, kind in schema.COLUMNS[table]:
                        if kind == "TIMESTAMP" and isinstance(row.get(column), str):
                            row[column] = datetime.fromisoformat(row[column].replace("Z", "+00:00"))
                            if row[column].tzinfo is not None:
                                row[column] = row[column].astimezone(UTC).replace(tzinfo=None)
                    converted.append(schema.row(table, **row))
                self.write(table, converted)
            self.unit_threads[self.source_id] = [row["thread_id"] for row in tables.get("threads", [])]
        self.write_coverage_and_meta({f"hp_archive:{self.source_id}:saved_at": self.payload["savedAt"]})
        self.summary.notes.append(
            "Selected complete HP archive export; standard staging, source-scoped replacement and ledger. "
            "The production config/CLI does not yet register an HP source."
        )


def main() -> None:
    """Run the isolated source adapter without reading another provider's storage."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("database", type=Path)
    options = parser.parse_args()
    summary = HpExportIngest(options.export, options.database).run()
    print(json.dumps(summary.to_dict(), default=str))


if __name__ == "__main__":
    main()
