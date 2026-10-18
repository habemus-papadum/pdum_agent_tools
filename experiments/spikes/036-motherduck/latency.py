# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Time six typical queries against ``md:agent_history`` and against the two local files.

    uv run --frozen --all-packages --env-file .env python -u experiments/spikes/036-motherduck/latency.py

Each query runs three times back to back on each side; the first run is reported as cold and the faster of
the other two as warm. The local side is a fresh in-memory DuckDB with both files attached read-only and one
UNION ALL view per table, so the SQL text is identical on both sides. Results carry only counts, ids and
aggregates: no conversation text leaves the databases.

Writes ``experiments/artifacts/036-motherduck/latency.json``.
"""

from __future__ import annotations

import argparse
import time
from typing import Any

import common
import duckdb

QUERIES: dict[str, str] = {
    "a_count_responses": "SELECT count(*) FROM responses",
    "b_monthly_usage": """
        SELECT date_trunc('month', ts) AS month, source, sum(total_tokens) AS total_tokens, count(*) AS events
        FROM usage_events GROUP BY 1, 2 ORDER BY 1, 2""",
    "c_session_list": """
        SELECT t.thread_id, t.source, t.updated_at, u.events, u.total_tokens
        FROM threads t
        LEFT JOIN (SELECT source_id, thread_id, count(*) AS events, sum(total_tokens) AS total_tokens
                   FROM usage_events GROUP BY 1, 2) u
          ON u.source_id = t.source_id AND u.thread_id = t.thread_id
        WHERE t.parent_thread_id IS NULL
        ORDER BY t.updated_at DESC NULLS LAST LIMIT 20""",
    "d_search_ilike": "SELECT count(*) FROM item_blobs WHERE item_json ILIKE '%duckdb%'",
    "e_point_lookup": "SELECT thread_id, turn_id, item_id, length(item_json) FROM item_blobs WHERE thread_id = ? AND item_id = ?",
    "f_cache_share_by_index": """
        WITH r AS (SELECT thread_id, turn_id, input_tokens, cached_input_tokens,
                          row_number() OVER (PARTITION BY thread_id, turn_id ORDER BY ts) AS idx
                   FROM responses)
        SELECT idx, count(*) AS responses,
               round(sum(cached_input_tokens)::DOUBLE / NULLIF(sum(input_tokens), 0), 4) AS cache_read_share
        FROM r WHERE idx <= 10 GROUP BY idx ORDER BY idx""",
}

TITLES: dict[str, str] = {
    "a_count_responses": "count(*) over responses",
    "b_monthly_usage": "monthly tokens and events by source",
    "c_session_list": "20 newest root threads with summed usage",
    "d_search_ilike": "ILIKE '%duckdb%' over item_blobs",
    "e_point_lookup": "one item_blobs row by thread_id and item_id",
    "f_cache_share_by_index": "cache-read share by response index (window)",
}


def signature(key: str, rows: list[tuple]) -> Any:
    """A small, text-free fingerprint of a result so both sides can be checked for agreement."""
    if key in ("a_count_responses", "d_search_ilike"):
        return rows[0][0]
    if key == "b_monthly_usage":
        return {"rows": len(rows), "events": sum(r[3] for r in rows), "tokens": sum(r[2] or 0 for r in rows)}
    if key == "c_session_list":
        return [r[0] for r in rows[:3]]
    if key == "e_point_lookup":
        return {"rows": len(rows), "item_json_len": rows[0][3] if rows else None}
    return [(r[0], r[2]) for r in rows]


def run_side(con: duckdb.DuckDBPyConnection, pair: tuple[str, str], runs: int) -> dict[str, Any]:
    """Run every query ``runs`` times and collect per-run milliseconds."""
    out: dict[str, Any] = {}
    for key, sql in QUERIES.items():
        params = list(pair) if key == "e_point_lookup" else None
        times: list[float] = []
        rows: list[tuple] = []
        error = None
        for _ in range(runs):
            try:
                seconds, rows = common.timed(con, sql, params)
                times.append(common.ms(seconds))
            except Exception as exc:
                error = common.redact(f"{type(exc).__name__}: {exc}")
                break
        entry: dict[str, Any] = {"ms": times}
        if error:
            entry["error"] = error
        if times:
            entry["cold_ms"] = times[0]
            entry["warm_ms"] = min(times[1:]) if len(times) > 1 else None
            entry["rows"] = len(rows)
            entry["signature"] = signature(key, rows)
        out[key] = entry
        print(f"  {key:24s} {times}", flush=True)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--out", default="latency.json")
    args = parser.parse_args()

    report: dict[str, Any] = {"started_at": common.now_iso(), "runs": args.runs, "queries": QUERIES, "titles": TITLES}

    start = time.perf_counter()
    local = common.connect_local_union()
    report["local_open_s"] = round(time.perf_counter() - start, 3)
    pair = local.execute(
        "SELECT thread_id, item_id FROM codex.main.item_blobs ORDER BY thread_id, item_id LIMIT 1"
    ).fetchone()
    report["point_lookup"] = {"thread_id": pair[0], "item_id": pair[1]}
    report["local_schema_version"] = common.local_schema_version(local, "codex")

    start = time.perf_counter()
    md = common.connect_md(f"md:{common.DATABASE}")
    report["motherduck_connect_s"] = round(time.perf_counter() - start, 3)
    report["versions"] = common.versions(md)
    print("motherduck", flush=True)
    report["motherduck"] = run_side(md, pair, args.runs)
    md.close()

    print("local", flush=True)
    report["local"] = run_side(local, pair, args.runs)
    local.close()

    report["agree"] = {
        k: report["motherduck"][k].get("signature") == report["local"][k].get("signature") for k in QUERIES
    }
    report["finished_at"] = common.now_iso()
    path = common.write_json(args.out, report)
    print(f"agreement: {report['agree']}; wrote {path}", flush=True)


if __name__ == "__main__":
    main()
