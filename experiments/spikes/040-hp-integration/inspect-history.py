"""Exercise the existing eval measurement function on HP data; no task grading or inference."""

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    directory = Path.home() / "history" / "evals" / f"hp-spike-{args.source.name}"
    directory.mkdir(parents=True, exist_ok=False)
    shutil.copy2(args.database, directory / "history.duckdb")
    shutil.copy2(args.source / "journal.json", directory / "journal.json")
    manifest = {
        "run_id": directory.name,
        "task": "hp-protocol-smoke",
        "label": "HP integration",
        "agent": "hp-agent",
        "exit_code": 0,
        "note": "Schema/measurement smoke only; no coding-task grade",
    }
    (directory / "run.json").write_text(json.dumps(manifest, indent=2))
    sys.path.insert(0, str(REPO / "experiments/evals/bin"))
    spec = importlib.util.spec_from_file_location("existing_eval_report", REPO / "experiments/evals/bin/report.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    measured = module.measure(manifest)
    with duckdb.connect(str(directory / "history.duckdb"), read_only=True) as con:
        counts = {
            table: con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in ["threads", "turns", "items", "responses", "fork_edges", "spawn_edges"]
        }
        own_bytes, all_bytes = con.execute("""SELECT
            sum(output_bytes) FILTER (WHERE origin <> 'copied-context'), sum(output_bytes) FROM items""").fetchone()
        estimate = con.execute("""SELECT sum((input_tokens-cached_input_tokens-cache_write_input_tokens)*0.10
            + cached_input_tokens*0.01 + cache_write_input_tokens*0.125 + output_tokens*0.50)/1e6
            FROM responses WHERE origin <> 'copied-context'""").fetchone()[0]
        duplicates = con.execute("SELECT count(*)-count(DISTINCT response_id) FROM responses").fetchone()[0]
    result = {
        "schema_measurement_passed": counts["responses"] > 0 and duplicates == 0,
        "counts": counts,
        "existing_eval_measure": measured,
        "dated_2026_10_18_short_context_default_estimate_usd": estimate,
        "own_tool_bytes": own_bytes,
        "including_inherited_tool_bytes": all_bytes,
        "quality_comparison": "not run",
        "actual_billing": "unknown",
    }
    (directory / "measurement.json").write_text(json.dumps(result, indent=2, default=str))
    print(json.dumps({"directory": str(directory), **result}, indent=2, default=str))


if __name__ == "__main__":
    main()
