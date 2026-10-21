"""Write experimental HP rows through the existing schema; never infer missing usage.

Run with the repository's root environment (pdum.agent_history is a production package):
uv run --frozen python experiments/spikes/039-hp-agent-runtime/write_history.py INPUT OUTPUT
"""

import argparse
import json
from pathlib import Path

import duckdb
from pdum.agent_history import schema


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    payload = json.loads(args.input.read_text())
    if payload["schemaVersion"] != schema.SCHEMA_VERSION:
        raise SystemExit("Schema changed: review the exporter before writing")
    if args.output.exists():
        raise SystemExit("Output already exists; choose a new isolated database")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(args.output))
    try:
        schema.create(connection)
        counts = {}
        for table, records in payload["tables"].items():
            columns = dict(schema.COLUMNS[table])
            rows = []
            for record in records:
                unknown = record.keys() - columns.keys()
                if unknown:
                    raise ValueError(f"Unknown {table} columns: {sorted(unknown)}")
                converted = {
                    key: schema.from_iso(value) if columns[key] == "TIMESTAMP" else value
                    for key, value in record.items()
                }
                rows.append(schema.row(table, **converted))
            counts[table] = schema.insert(connection, table, rows)
        print(json.dumps({"schemaVersion": schema.SCHEMA_VERSION, "rows": counts}, indent=2))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
