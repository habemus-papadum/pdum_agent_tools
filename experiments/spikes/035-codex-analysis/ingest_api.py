"""API ingester: read-side app-server RPCs into the shared DuckDB schema.

Only read methods are used: ``thread/list``, ``thread/turns/list``, ``thread/items/list``,
``thread/read``, ``thread/items/read``, ``thread/timeline/list``, ``thread/search`` and
``thread/loaded/list``. Nothing is resumed or started. Every call's latency lands in
``rpc_calls`` so the report can compare paths.

    uv run --project .. --with duckdb==1.5.6 --with pyarrow==26.0.0 python spikes/035-codex-analysis/ingest_api.py \
        --endpoint unix:///path/to/app.sock --out artifacts/035-codex-analysis/<run> --label snapshot
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import items as item_columns  # noqa: E402
import schema  # noqa: E402
from client import Client, RpcError  # noqa: E402

SOURCE = "api"
ALL_SOURCE_KINDS = [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
]
SEARCH_TERM = "duckdb"


async def page(
    client: Client, method: str, params: dict[str, Any], *, key: str = "data", max_pages: int = 10_000
) -> tuple[list[Any], int]:
    cursor: str | None = None
    rows: list[Any] = []
    pages = 0
    while pages < max_pages:
        result = await client.request(method, {**params, "cursor": cursor})
        rows.extend(result.get(key) or [])
        pages += 1
        cursor = result.get("nextCursor")
        if not cursor:
            break
    return rows, pages


def thread_row(thread: dict[str, Any], archived: bool) -> tuple:
    git = thread.get("gitInfo") or {}
    source = thread.get("source")
    if isinstance(source, dict):
        source_kind = next(iter(source), None)
    else:
        source_kind = source
    return schema.row(
        "threads",
        thread_id=thread.get("id"),
        session_id=thread.get("sessionId"),
        forked_from_id=thread.get("forkedFromId"),
        parent_thread_id=thread.get("parentThreadId"),
        created_at=schema.from_ms(thread.get("createdAt")),
        updated_at=schema.from_ms(thread.get("updatedAt")),
        source_kind=source_kind,
        thread_source=thread.get("threadSource")
        if isinstance(thread.get("threadSource"), str)
        else json.dumps(thread.get("threadSource"))
        if thread.get("threadSource")
        else None,
        originator=thread.get("originator"),
        cli_version=thread.get("cliVersion"),
        model_provider=thread.get("modelProvider"),
        cwd=thread.get("cwd"),
        git_branch=git.get("branch"),
        git_origin=git.get("originUrl"),
        git_sha=git.get("sha"),
        title=thread.get("name"),
        preview_len=len(thread.get("preview") or ""),
        model=thread.get("model"),
        reasoning_effort=thread.get("reasoningEffort"),
        archived=archived,
        history_mode=thread.get("historyMode"),
        agent_nickname=thread.get("agentNickname"),
        agent_role=thread.get("agentRole"),
        rollout_path=thread.get("path"),
        source=SOURCE,
        origin="thread/list",
    )


def turn_row(thread_id: str, turn: dict[str, Any]) -> tuple:
    error = turn.get("error") or {}
    started = turn.get("startedAt")
    completed = turn.get("completedAt")
    info = error.get("codexErrorInfo")
    return schema.row(
        "turns",
        thread_id=thread_id,
        turn_id=turn.get("id"),
        root_turn_id=turn.get("rootTurnId"),
        status=turn.get("status"),
        error_message=(error.get("message") or "")[:500] or None,
        error_kind=info if isinstance(info, str) else json.dumps(info)[:120] if info else None,
        started_at=schema.from_ms(started),
        completed_at=schema.from_ms(completed),
        duration_ms=turn.get("durationMs"),
        source=SOURCE,
        origin="thread/turns/list",
    )


def item_row(thread_id: str, entry: dict[str, Any], origin: str) -> tuple[tuple, tuple | None]:
    item = entry.get("item") or {}
    columns = item_columns.extract(item)
    output = columns.pop("_output", None)
    started = entry.get("startedAtMs")
    completed = entry.get("completedAtMs")
    columns.update(
        thread_id=thread_id,
        turn_id=entry.get("turnId"),
        started_at=schema.from_ms(started),
        completed_at=schema.from_ms(completed),
        duration_ms=(completed - started) if isinstance(started, int) and isinstance(completed, int) else None,
        item_json_bytes=len(json.dumps(item)),
        source=SOURCE,
        origin=origin,
    )
    output_row = None
    if isinstance(output, str) and output:
        output_row = schema.row(
            "command_outputs",
            thread_id=thread_id,
            turn_id=entry.get("turnId"),
            item_id=item.get("id"),
            output=output,
            source=SOURCE,
            origin=origin,
        )
    return schema.row("items", **columns), output_row


def method_stats(calls: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_method: dict[str, list[dict[str, Any]]] = {}
    for call in calls:
        by_method.setdefault(call["method"], []).append(call)
    stats = {}
    for method, group in sorted(by_method.items()):
        latencies = sorted(c["ms"] for c in group)
        stats[method] = {
            "calls": len(group),
            "errors": sum(1 for c in group if not c.get("ok")),
            "total_ms": round(sum(latencies), 1),
            "p50_ms": round(statistics.median(latencies), 1),
            "p95_ms": round(latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))], 1),
            "max_ms": round(latencies[-1], 1),
            "rows": sum(c.get("result_rows") or 0 for c in group),
        }
    return stats


async def ingest(
    endpoint: str,
    out: Path,
    *,
    label: str,
    max_threads: int | None = None,
    sample: int = 5,
    search: str | None = SEARCH_TERM,
    concurrency: int = 1,
    outputs: bool = True,
    keep_calls: bool = True,
    materialize: bool = False,
) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    out.mkdir(parents=True, exist_ok=True)
    db_path = out / f"api-{label}.duckdb"
    if db_path.exists():
        db_path.unlink()
    con = duckdb.connect(str(db_path))
    schema.create(con)
    summary: dict[str, Any] = {
        "run_id": run_id,
        "label": label,
        "endpoint": endpoint,
        "phases": {},
        "errors": [],
        "concurrency": concurrency,
        "materialize": materialize,
    }
    wall = time.perf_counter()

    def phase(name: str, started: float, rows: int, detail: str = "") -> None:
        seconds = time.perf_counter() - started
        summary["phases"][name] = {"seconds": round(seconds, 3), "rows": rows, "detail": detail}
        print(f"[{label}] phase {name}: {seconds:.1f}s rows={rows} {detail}", file=sys.stderr, flush=True)
        schema.insert(
            con,
            "ingest_runs",
            [
                schema.row(
                    "ingest_runs",
                    run_id=run_id,
                    source=SOURCE,
                    phase=name,
                    started_at=datetime.now(UTC).replace(tzinfo=None),
                    seconds=seconds,
                    rows=rows,
                    detail=detail,
                )
            ],
        )

    started = time.perf_counter()
    client = await Client(f"spike035-{label}").open(endpoint)
    summary["server_info"] = client.server_info
    phase("initialize", started, 1, json.dumps(client.server_info)[:200])

    # ---------------------------------------------------------------- thread/list
    started = time.perf_counter()
    listed: dict[str, tuple[dict[str, Any], bool]] = {}
    pages_total = 0
    for archived in (False, True):
        rows, pages = await page(
            client, "thread/list", {"limit": 100, "archived": archived, "sourceKinds": ALL_SOURCE_KINDS}
        )
        pages_total += pages
        for thread in rows:
            listed.setdefault(thread["id"], (thread, archived))
    schema.insert(con, "threads", [thread_row(thread, archived) for thread, archived in listed.values()])
    phase("thread_list", started, len(listed), f"pages {pages_total}")
    selected = list(listed.values())
    if max_threads is not None:
        selected = selected[:max_threads]

    # ------------------------------------------------------- per-thread history
    started = time.perf_counter()
    semaphore = asyncio.Semaphore(max(1, concurrency))
    coverage_rows: list[tuple] = []
    turn_total = item_total = 0

    async def one(thread: dict[str, Any], archived: bool) -> None:
        nonlocal turn_total, item_total
        thread_id = thread["id"]
        turns: list[dict[str, Any]] = []
        entries: list[dict[str, Any]] = []
        errors = 0
        async with semaphore:
            if materialize:
                # A paginated rollout without a SQLite projection lists no turns; resuming
                # loads the thread and materializes its projection as a side effect.
                try:
                    await client.request("thread/resume", {"threadId": thread_id}, timeout=120)
                except RpcError as error:
                    errors += 1
                    summary["errors"].append(
                        {"thread": thread_id, "method": "thread/resume", "error": str(error)[:300]}
                    )
            try:
                turns, _ = await page(
                    client,
                    "thread/turns/list",
                    {"threadId": thread_id, "limit": 100, "sortDirection": "asc", "itemsView": "notLoaded"},
                )
            except RpcError as error:
                errors += 1
                summary["errors"].append(
                    {"thread": thread_id, "method": "thread/turns/list", "error": str(error)[:300]}
                )
            try:
                entries, _ = await page(
                    client, "thread/items/list", {"threadId": thread_id, "limit": 200, "sortDirection": "asc"}
                )
            except RpcError as error:
                errors += 1
                summary["errors"].append(
                    {"thread": thread_id, "method": "thread/items/list", "error": str(error)[:300]}
                )
        schema.insert(con, "turns", [turn_row(thread_id, turn) for turn in turns])
        item_rows = []
        output_rows = []
        for entry in entries:
            item, output = item_row(thread_id, entry, "thread/items/list")
            item_rows.append(item)
            if output is not None and outputs:
                output_rows.append(output)
        schema.insert(con, "items", item_rows)
        schema.insert(con, "command_outputs", output_rows)
        turn_total += len(turns)
        item_total += len(entries)
        coverage_rows.append(
            schema.row(
                "coverage",
                thread_id=thread_id,
                in_catalogue=True,
                in_projection=bool(turns) or bool(entries),
                rollout_format=thread.get("historyMode"),
                projection_turns=len(turns),
                projection_items=len(entries),
                unknown_line_types=errors,
                source=SOURCE,
                origin="ingest_api",
            )
        )

    # DuckDB connections are not safe for concurrent use; the semaphore serializes RPC
    # fan-out while inserts happen on the event loop thread between awaits.
    await asyncio.gather(*(one(thread, archived) for thread, archived in selected))
    schema.insert(con, "coverage", coverage_rows)
    phase(
        "thread_history",
        started,
        turn_total + item_total,
        f"threads {len(selected)}; turns {turn_total}; items {item_total}; errors {len(summary['errors'])}",
    )

    # --------------------------------------------------------------- samples
    started = time.perf_counter()
    samples: list[dict[str, Any]] = []
    for thread, _archived in selected[: max(0, sample)]:
        thread_id = thread["id"]
        record: dict[str, Any] = {"thread": thread_id}
        try:
            read = await client.request("thread/read", {"threadId": thread_id})
            record["thread_read_turns"] = len((read.get("thread") or {}).get("turns") or [])
        except RpcError as error:
            record["thread_read_error"] = str(error)[:200]
        try:
            full, pages = await page(
                client,
                "thread/turns/list",
                {"threadId": thread_id, "limit": 100, "sortDirection": "asc", "itemsView": "full"},
            )
            record["turns_full_pages"] = pages
            record["turns_full_items"] = sum(len(turn.get("items") or []) for turn in full)
        except RpcError as error:
            record["turns_full_error"] = str(error)[:200]
        try:
            timeline, pages = await page(client, "thread/timeline/list", {"threadId": thread_id, "limit": 200})
            kinds: dict[str, int] = {}
            for entry in timeline:
                kinds[entry.get("type", "?")] = kinds.get(entry.get("type", "?"), 0) + 1
            record["timeline_pages"] = pages
            record["timeline_entries"] = kinds
        except RpcError as error:
            record["timeline_error"] = str(error)[:200]
        try:
            first = con.execute(
                "SELECT turn_id, item_id FROM items WHERE thread_id = ? AND item_type = 'commandExecution' LIMIT 1",
                [thread_id],
            ).fetchone()
            if first:
                read_items = await client.request(
                    "thread/items/read", {"threadId": thread_id, "turnId": first[0], "itemIds": [first[1]]}
                )
                record["items_read_rows"] = len(read_items.get("data") or [])
        except RpcError as error:
            record["items_read_error"] = str(error)[:200]
        samples.append(record)
    summary["samples"] = samples
    phase("samples", started, len(samples))

    # ---------------------------------------------------------- search, loaded
    started = time.perf_counter()
    if search:
        try:
            found, pages = await page(
                client, "thread/search", {"searchTerm": search, "limit": 100, "sourceKinds": ALL_SOURCE_KINDS}
            )
            summary["search"] = {"term": search, "threads": len(found), "pages": pages}
        except RpcError as error:
            summary["search"] = {"term": search, "error": str(error)[:300]}
    try:
        loaded, _ = await page(client, "thread/loaded/list", {"limit": 100})
        summary["loaded_threads"] = len(loaded)
    except RpcError as error:
        summary["loaded_threads_error"] = str(error)[:300]
    phase("search_and_loaded", started, summary.get("search", {}).get("threads", 0) or 0)

    await client.close()
    if keep_calls:
        schema.insert(
            con,
            "rpc_calls",
            [
                schema.row(
                    "rpc_calls",
                    run_id=run_id,
                    method=c["method"],
                    params_summary=c["params_summary"],
                    started_at=c["started_at"],
                    ms=c["ms"],
                    ok=c.get("ok"),
                    result_rows=c.get("result_rows"),
                    error=c.get("error"),
                )
                for c in client.calls
            ],
        )
    summary["methods"] = method_stats(client.calls)
    summary["rpc_calls"] = len(client.calls)
    summary["wall_seconds"] = round(time.perf_counter() - wall, 3)
    summary["tables"] = {table: con.execute(f"select count(*) from {table}").fetchone()[0] for table in schema.COLUMNS}
    con.execute("CHECKPOINT")
    con.close()
    summary["db_bytes"] = db_path.stat().st_size
    summary["db_path"] = str(db_path)
    (out / f"ingest_api_{label}.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--endpoint", required=True, help="unix:///path or ws://host:port")
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="api")
    parser.add_argument("--max-threads", type=int)
    parser.add_argument("--sample", type=int, default=5)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--no-search", action="store_true")
    parser.add_argument("--no-outputs", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    summary = asyncio.run(
        ingest(
            args.endpoint,
            Path(args.out).expanduser().resolve(),
            label=args.label,
            max_threads=args.max_threads,
            sample=args.sample,
            search=None if args.no_search else SEARCH_TERM,
            concurrency=args.concurrency,
            outputs=not args.no_outputs,
        )
    )
    print(
        json.dumps(
            {
                k: summary[k]
                for k in (
                    "run_id",
                    "label",
                    "wall_seconds",
                    "rpc_calls",
                    "tables",
                    "methods",
                    "phases",
                    "search",
                    "samples",
                    "errors",
                )
                if k in summary
            },
            indent=2,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
