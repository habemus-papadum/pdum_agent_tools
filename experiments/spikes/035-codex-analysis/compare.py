# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Compare the API path's tables with the filesystem path's tables, row for row where ids allow.

    uv run --project .. --with duckdb==1.5.6 python spikes/035-codex-analysis/compare.py \
        --fs artifacts/.../fs.duckdb --api artifacts/.../api-snapshot.duckdb --label snapshot --out artifacts/...
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import duckdb

TABLES = [
    "threads",
    "spawn_edges",
    "turns",
    "responses",
    "token_counts",
    "items",
    "command_outputs",
    "rollout_events",
    "response_items",
    "logs",
]


def compare(fs: Path, api: Path, label: str) -> dict[str, Any]:
    con = duckdb.connect()
    con.execute(f"ATTACH '{fs}' AS fs (READ_ONLY)")
    con.execute(f"ATTACH '{api}' AS api (READ_ONLY)")
    result: dict[str, Any] = {
        "label": label,
        "fs": str(fs),
        "api": str(api),
        "tables": {},
        "threads": {},
        "turns": {},
        "items": {},
    }
    for table in TABLES:
        fs_count = con.execute(f"select count(*) from fs.{table}").fetchone()[0]
        api_count = con.execute(f"select count(*) from api.{table}").fetchone()[0]
        result["tables"][table] = {"fs": fs_count, "api": api_count, "api_empty": api_count == 0}

    # The API run may be bounded to the first N listed threads; compare within its scope.
    scope = "(SELECT thread_id FROM api.coverage)"
    t = result["threads"]
    t["listed_by_api"] = con.execute("select count(*) from api.threads").fetchone()[0]
    t["fs_threads"] = con.execute("select count(*) from fs.threads").fetchone()[0]
    t["only_fs"] = con.execute(
        "select count(*) from fs.threads f where not exists (select 1 from api.threads a where a.thread_id = f.thread_id)"
    ).fetchone()[0]
    t["only_api"] = con.execute(
        "select count(*) from api.threads a where not exists (select 1 from fs.threads f where f.thread_id = a.thread_id)"
    ).fetchone()[0]
    t["only_fs_formats"] = con.execute(
        "select coalesce(rollout_format, 'unknown') fmt, coalesce(origin, '') origin, count(*) from fs.threads f where not exists (select 1 from api.threads a where a.thread_id = f.thread_id) group by 1, 2"
    ).fetchall()
    mismatches = {}
    for column in (
        "forked_from_id",
        "parent_thread_id",
        "cli_version",
        "model",
        "reasoning_effort",
        "git_branch",
        "cwd",
        "source_kind",
        "archived",
    ):
        mismatches[column] = con.execute(
            f"select count(*) from fs.threads f join api.threads a using (thread_id) where f.{column} is distinct from a.{column}"
        ).fetchone()[0]
    mismatches["created_at_over_1s"] = con.execute(
        "select count(*) from fs.threads f join api.threads a using (thread_id) where abs(epoch(f.created_at) - epoch(a.created_at)) > 1"
    ).fetchone()[0]
    t["field_mismatches_in_shared_threads"] = mismatches
    t["shared"] = con.execute("select count(*) from fs.threads f join api.threads a using (thread_id)").fetchone()[0]

    u = result["turns"]
    u["fs_in_scope"] = con.execute(f"select count(*) from fs.turns where thread_id in {scope}").fetchone()[0]
    u["fs_projection_in_scope"] = con.execute(
        f"select count(*) from fs.turns where thread_id in {scope} and origin like 'thread_history_1%'"
    ).fetchone()[0]
    u["api"] = con.execute("select count(*) from api.turns").fetchone()[0]
    u["shared"] = con.execute("select count(*) from fs.turns f join api.turns a using (thread_id, turn_id)").fetchone()[
        0
    ]
    u["only_fs_in_scope"] = con.execute(
        f"select count(*) from fs.turns f where thread_id in {scope} and not exists (select 1 from api.turns a where a.thread_id = f.thread_id and a.turn_id = f.turn_id)"
    ).fetchone()[0]
    u["only_fs_in_scope_by_origin"] = con.execute(
        f"select origin, count(*) from fs.turns f where thread_id in {scope} and not exists (select 1 from api.turns a where a.thread_id = f.thread_id and a.turn_id = f.turn_id) group by 1"
    ).fetchall()
    u["only_api"] = con.execute(
        "select count(*) from api.turns a where not exists (select 1 from fs.turns f where f.thread_id = a.thread_id and f.turn_id = a.turn_id)"
    ).fetchone()[0]
    u["status_mismatch"] = con.execute(
        "select count(*) from fs.turns f join api.turns a using (thread_id, turn_id) where f.status is distinct from a.status"
    ).fetchone()[0]
    u["duration_mismatch"] = con.execute(
        "select count(*) from fs.turns f join api.turns a using (thread_id, turn_id) where f.duration_ms is distinct from a.duration_ms"
    ).fetchone()[0]
    u["api_turns_with_model"] = con.execute("select count(*) from api.turns where model is not null").fetchone()[0]
    u["fs_turns_with_model_in_scope"] = con.execute(
        f"select count(*) from fs.turns where thread_id in {scope} and model is not null"
    ).fetchone()[0]

    i = result["items"]
    i["fs_in_scope"] = con.execute(f"select count(*) from fs.items where thread_id in {scope}").fetchone()[0]
    i["api"] = con.execute("select count(*) from api.items").fetchone()[0]
    i["shared"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id)"
    ).fetchone()[0]
    i["only_fs_in_scope"] = con.execute(
        f"select count(*) from fs.items f where thread_id in {scope} and not exists (select 1 from api.items a where a.thread_id = f.thread_id and a.turn_id = f.turn_id and a.item_id = f.item_id)"
    ).fetchone()[0]
    i["only_api"] = con.execute(
        "select count(*) from api.items a where not exists (select 1 from fs.items f where f.thread_id = a.thread_id and f.turn_id = a.turn_id and f.item_id = a.item_id)"
    ).fetchone()[0]
    i["type_mismatch"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id) where f.item_type is distinct from a.item_type"
    ).fetchone()[0]
    i["duration_mismatch"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id) where f.duration_ms is distinct from a.duration_ms"
    ).fetchone()[0]
    i["output_bytes_mismatch"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id) where f.output_bytes is distinct from a.output_bytes"
    ).fetchone()[0]
    i["text_len_mismatch"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id) where f.text_len is distinct from a.text_len"
    ).fetchone()[0]
    i["status_mismatch"] = con.execute(
        "select count(*) from fs.items f join api.items a using (thread_id, turn_id, item_id) where f.status is distinct from a.status"
    ).fetchone()[0]
    i["only_fs_by_type"] = con.execute(
        f"select item_type, count(*) from fs.items f where thread_id in {scope} and not exists (select 1 from api.items a where a.thread_id = f.thread_id and a.turn_id = f.turn_id and a.item_id = f.item_id) group by 1 order by 2 desc"
    ).fetchall()

    result["usage_visible_to_api"] = {
        "responses": con.execute("select count(*) from api.responses").fetchone()[0],
        "token_counts": con.execute("select count(*) from api.token_counts").fetchone()[0],
        "fs_responses_in_scope": con.execute(
            f"select count(*) from fs.responses where thread_id in {scope}"
        ).fetchone()[0],
        "fs_token_counts_in_scope": con.execute(
            f"select count(*) from fs.token_counts where thread_id in {scope}"
        ).fetchone()[0],
    }
    con.close()
    return result


def markdown(result: dict[str, Any]) -> str:
    lines = [
        f"## {result['label']}: API tables against filesystem tables",
        "",
        "| Table | fs rows | api rows |",
        "| --- | ---: | ---: |",
    ]
    for table, counts in result["tables"].items():
        lines.append(f"| {table} | {counts['fs']} | {counts['api']} |")
    lines += [
        "",
        "```json",
        json.dumps(
            {k: result[k] for k in ("threads", "turns", "items", "usage_visible_to_api")}, indent=2, default=str
        ),
        "```",
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fs", required=True)
    parser.add_argument("--api", required=True)
    parser.add_argument("--label", default="api")
    parser.add_argument("--out")
    args = parser.parse_args()
    result = compare(Path(args.fs).resolve(), Path(args.api).resolve(), args.label)
    out = Path(args.out).resolve() if args.out else Path(args.api).resolve().parent
    (out / f"compare_{args.label}.json").write_text(json.dumps(result, indent=2, default=str) + "\n")
    (out / f"compare_{args.label}.md").write_text(markdown(result))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
