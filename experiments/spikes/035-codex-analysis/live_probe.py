"""One live gpt-6-luna turn with a subscribed client, written into the shared schema.

A temporary launcher profile borrows the ordinary file-backed login into memory for the
run; the ordinary home is not modified. The client subscribes before the turn, records
every notification, and after completion the same thread's persisted rollout is ingested
with the filesystem ingester so live rows and persisted rows can be compared by id.

Bounds: one thread, one turn, low effort, read-only sandbox, 180 second deadline,
an API-equivalent estimate well under USD 0.10 at the dated Luna rates.

    uv run --project .. --with duckdb==1.5.6 --with pyarrow==26.0.0 python spikes/035-codex-analysis/live_probe.py \
        --out artifacts/035-codex-analysis/<run>
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
from pdum.codex_launcher import LaunchOptions, ProfileSpec, launch, temporary_profile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_fs  # noqa: E402
import items as item_columns  # noqa: E402
import schema  # noqa: E402
from client import Client  # noqa: E402

MODEL = "gpt-6-luna"
PROMPT = "Run the shell command `echo spike035` once, then reply with exactly the word done."
PRICE_DATE = "2026-10-16"
LUNA = {"uncached": 0.1, "cached": 0.01, "cache_write": 0.125, "output": 0.5}  # USD per million, standard tier
DEADLINE = 180
SOURCE = "live"


def estimate(usage: dict[str, Any]) -> float:
    uncached = max(
        usage.get("inputTokens", 0) - usage.get("cachedInputTokens", 0) - usage.get("cacheWriteInputTokens", 0), 0
    )
    return (
        uncached * LUNA["uncached"]
        + usage.get("cachedInputTokens", 0) * LUNA["cached"]
        + usage.get("cacheWriteInputTokens", 0) * LUNA["cache_write"]
        + usage.get("outputTokens", 0) * LUNA["output"]
    ) / 1e6


async def probe(out: Path, codex: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"model": MODEL, "price_date": PRICE_DATE, "started_at": datetime.now(UTC).isoformat()}
    auth_source = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "auth.json"
    auth_hash_before = hashlib.sha256(auth_source.read_bytes()).hexdigest() if auth_source.exists() else None
    spec = ProfileSpec(executable=codex, model=MODEL, copy_skills=False)
    overrides = {
        "model_reasoning_effort": '"low"',
        "service_tier": '"default"',
        "web_search": '"disabled"',
        "analytics.enabled": "false",
        "feedback.enabled": "false",
        "features.apps": "false",
        "features.plugins": "false",
        "skills.bundled.enabled": "false",
    }
    async with temporary_profile(spec, copy_auth=True, parent=out) as info:
        profile = info.directory
        result["profile_warnings"] = list(info.warnings)
        result["auth_file_present"] = info.auth_file_present
        options = LaunchOptions(
            executable=codex,
            relay=False,
            environment_mode="clean",
            model=MODEL,
            config_overrides=overrides,
            startup_timeout=120,
        )
        notifications_path = out / "live_notifications.jsonl"
        async with launch(profile, options) as server:
            client = await Client("spike035-live").open(server.backend_endpoint)
            result["server_info"] = client.server_info
            work = profile / ".pdum" / "work"
            work.mkdir(parents=True, exist_ok=True)
            started = time.perf_counter()
            try:
                async with asyncio.timeout(DEADLINE):
                    thread = await client.request(
                        "thread/start",
                        {"model": MODEL, "cwd": str(work), "approvalPolicy": "never", "sandbox": "read-only"},
                    )
                    thread_id = thread["thread"]["id"]
                    result["thread_id"] = thread_id
                    result["thread_start_ms"] = round(client.calls[-1]["ms"], 1)
                    turn = await client.request(
                        "turn/start",
                        {
                            "threadId": thread_id,
                            "model": MODEL,
                            "effort": "low",
                            "serviceTier": "default",
                            "input": [{"type": "text", "text": PROMPT}],
                        },
                    )
                    turn_id = turn["turn"]["id"]
                    result["turn_id"] = turn_id
                    completed = await client.wait(
                        "turn/completed",
                        predicate=lambda m: m.get("params", {}).get("turn", {}).get("id") == turn_id,
                        timeout=DEADLINE,
                    )
                    result["turn_status"] = completed["params"]["turn"].get("status")
                    result["turn_wall_seconds"] = round(time.perf_counter() - started, 2)
            except TimeoutError:
                result["error"] = "deadline exceeded"
                try:
                    await client.request(
                        "turn/interrupt", {"threadId": result.get("thread_id"), "turnId": result.get("turn_id")}
                    )
                except Exception as error:  # noqa: BLE001
                    result["interrupt_error"] = type(error).__name__
            await asyncio.sleep(1.5)  # let trailing notifications and the rollout flush land
            with notifications_path.open("w") as stream:
                for message in client.notifications:
                    stream.write(json.dumps(message, default=str) + "\n")
            await client.close()
            result["rpc_calls"] = client.calls
            result = write_live_tables(out, client.notifications, result)
            # Persisted view of the same thread, through the filesystem ingester on the temporary home.
            persisted = ingest_fs.Ingest(profile, out / "live-fs", outputs=True)
            persisted.catalogue()
            persisted.projection()
            persisted.rollouts()
            persisted.finish()
            result["persisted"] = {
                "tables": persisted.summary["tables"],
                "coverage": persisted.coverage.get(result.get("thread_id", ""), {}),
            }
    auth_hash_after = hashlib.sha256(auth_source.read_bytes()).hexdigest() if auth_source.exists() else None
    result["source_auth_unchanged"] = auth_hash_before == auth_hash_after
    result["finished_at"] = datetime.now(UTC).isoformat()
    return result


def write_live_tables(out: Path, notifications: list[dict[str, Any]], result: dict[str, Any]) -> dict[str, Any]:
    db_path = out / "live.duckdb"
    if db_path.exists():
        db_path.unlink()
    con = duckdb.connect(str(db_path))
    schema.create(con)
    items_rows: list[tuple] = []
    turn_rows: list[tuple] = []
    count_rows: list[tuple] = []
    response_rows: list[tuple] = []
    methods: dict[str, int] = {}
    started_at: dict[str, int] = {}
    last_usage: dict[str, Any] | None = None
    for message in notifications:
        method = message.get("method", "?")
        methods[method] = methods.get(method, 0) + 1
        params = message.get("params") or {}
        received = schema.from_ms(message.get("received_at"))
        if method == "item/started":
            started_at[(params.get("item") or {}).get("id", "")] = params.get("startedAtMs")
        elif method == "item/completed":
            item = params.get("item") or {}
            columns = item_columns.extract(item)
            columns.pop("_output", None)
            began = started_at.get(item.get("id", ""))
            ended = params.get("completedAtMs")
            columns.update(
                thread_id=params.get("threadId"),
                turn_id=params.get("turnId"),
                started_at=schema.from_ms(began),
                completed_at=schema.from_ms(ended),
                duration_ms=(ended - began) if isinstance(began, int) and isinstance(ended, int) else None,
                created_at=received,
                item_json_bytes=len(json.dumps(item)),
                source=SOURCE,
                origin="item/completed",
            )
            items_rows.append(schema.row("items", **columns))
        elif method == "turn/completed":
            turn = params.get("turn") or {}
            error = turn.get("error") or {}
            turn_rows.append(
                schema.row(
                    "turns",
                    thread_id=params.get("threadId"),
                    turn_id=turn.get("id"),
                    root_turn_id=turn.get("rootTurnId"),
                    status=turn.get("status"),
                    error_message=error.get("message"),
                    started_at=schema.from_ms(turn.get("startedAt")),
                    completed_at=schema.from_ms(turn.get("completedAt")),
                    duration_ms=turn.get("durationMs"),
                    model=MODEL,
                    source=SOURCE,
                    origin="turn/completed",
                )
            )
        elif method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage") or {}
            total = usage.get("total") or {}
            last = usage.get("last") or {}
            last_usage = usage
            count_rows.append(
                schema.row(
                    "token_counts",
                    thread_id=params.get("threadId"),
                    turn_id=params.get("turnId"),
                    ts=received,
                    total_input_tokens=total.get("inputTokens"),
                    total_cached_input_tokens=total.get("cachedInputTokens"),
                    total_cache_write_input_tokens=total.get("cacheWriteInputTokens"),
                    total_output_tokens=total.get("outputTokens"),
                    total_reasoning_output_tokens=total.get("reasoningOutputTokens"),
                    total_tokens=total.get("totalTokens"),
                    last_input_tokens=last.get("inputTokens"),
                    last_cached_input_tokens=last.get("cachedInputTokens"),
                    last_cache_write_input_tokens=last.get("cacheWriteInputTokens"),
                    last_output_tokens=last.get("outputTokens"),
                    last_reasoning_output_tokens=last.get("reasoningOutputTokens"),
                    last_total_tokens=last.get("totalTokens"),
                    model_context_window=usage.get("modelContextWindow"),
                    source=SOURCE,
                    origin="thread/tokenUsage/updated",
                )
            )
        elif method == "rawResponse/completed":
            usage = params.get("usage") or {}
            response_rows.append(
                schema.row(
                    "responses",
                    thread_id=params.get("threadId"),
                    turn_id=params.get("turnId"),
                    response_id=params.get("responseId"),
                    ts=received,
                    input_tokens=usage.get("inputTokens"),
                    cached_input_tokens=usage.get("cachedInputTokens"),
                    cache_write_input_tokens=usage.get("cacheWriteInputTokens"),
                    output_tokens=usage.get("outputTokens"),
                    reasoning_output_tokens=usage.get("reasoningOutputTokens"),
                    total_tokens=usage.get("totalTokens"),
                    source=SOURCE,
                    origin="rawResponse/completed",
                )
            )
    schema.insert(con, "items", items_rows)
    schema.insert(con, "turns", turn_rows)
    schema.insert(con, "token_counts", count_rows)
    schema.insert(con, "responses", response_rows)
    con.execute("CHECKPOINT")
    con.close()
    result["notification_methods"] = methods
    result["live_tables"] = {
        "items": len(items_rows),
        "turns": len(turn_rows),
        "token_counts": len(count_rows),
        "responses": len(response_rows),
    }
    result["live_item_types"] = sorted({row[4] for row in items_rows if row[4]})
    if last_usage:
        result["final_usage_total"] = last_usage.get("total")
        result["observed_api_equivalent_usd"] = round(estimate(last_usage.get("total") or {}), 6)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--codex")
    args = parser.parse_args()
    os.umask(0o077)
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    codex = Path(args.codex).expanduser().resolve() if args.codex else Path(shutil.which("codex") or "")
    if not codex.is_file():
        raise SystemExit("codex executable not found; pass --codex")
    result = asyncio.run(probe(out, codex))
    (out / "live_probe.json").write_text(json.dumps(result, indent=2, default=str) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k not in {"rpc_calls"}}, indent=2, default=str))


if __name__ == "__main__":
    main()
