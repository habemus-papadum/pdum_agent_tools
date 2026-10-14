"""Compare private protocol, provider traffic, and native OTLP without printing payloads."""

from __future__ import annotations

import argparse
import importlib.util
import json
from collections import Counter
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("accounting", ROOT / "spikes/033-codex-accounting/analysis.py")
accounting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounting)


def attributes(record: dict) -> dict:
    return {a["key"]: next(iter(a["value"].values())) for a in record.get("attributes", [])}


def analyze(directory: Path) -> dict:
    logs, spans, metrics = [], [], []
    for line in (directory / "otlp.jsonl").read_text().splitlines():
        body = json.loads(line)["payload"]
        for resource, scope, entries, target in (
            ("resourceLogs", "scopeLogs", "logRecords", logs),
            ("resourceSpans", "scopeSpans", "spans", spans),
            ("resourceMetrics", "scopeMetrics", "metrics", metrics),
        ):
            for r in body.get(resource, []):
                for s in r.get(scope, []):
                    target.extend(s.get(entries, []))
    native_usage = []
    for record in logs:
        data = attributes(record)
        if data.get("event.name") == "codex.sse_event" and "input_token_count" in data:
            counts = {
                k: int(data[v])
                for k, v in zip(
                    accounting.FIELDS,
                    ("input_token_count", "cached_token_count", "cache_write_token_count", "output_token_count"),
                )
            }
            native_usage.append({"model": data.get("model"), "counts": counts})

    requests, responses, seen = {}, [], set()
    for capture in sorted((directory / "upstream").glob("*/records.jsonl")):
        for line in capture.read_text().splitlines():
            record = json.loads(line)
            message = record.get("json")
            if record.get("kind") != "websocket_message" or not isinstance(message, dict):
                continue
            flow = record["flow_id"]
            if message.get("type") == "response.create":
                requests[flow] = message
            if message.get("type") != "response.completed":
                continue
            response = message["response"]
            if response["id"] in seen:
                continue
            seen.add(response["id"])
            usage = response["usage"]
            counts = {
                "inputTokens": usage["input_tokens"],
                "cachedInputTokens": usage["input_tokens_details"]["cached_tokens"],
                "cacheWriteInputTokens": usage["input_tokens_details"]["cache_write_tokens"],
                "outputTokens": usage["output_tokens"],
            }
            responses.append(
                {
                    "model": response["model"],
                    "counts": counts,
                    "warmup": requests[flow].get("generate") is False,
                    "estimatedUsd": accounting.price(counts, response["model"]),
                }
            )

    def signature(entry: dict) -> tuple:
        return (entry["model"], *(entry["counts"][k] for k in accounting.FIELDS))

    assert Counter(map(signature, native_usage)) == Counter(map(signature, responses))
    client = json.loads((directory / "client-analysis.json").read_text())
    client_cost = sum(Decimal(s["estimatedUsd"]) for s in client["threads"].values())
    generating = [r for r in responses if not r["warmup"]]
    warmups = [r for r in responses if r["warmup"]]
    generating_cost = sum(Decimal(r["estimatedUsd"]) for r in generating)
    warmup_cost = sum(Decimal(r["estimatedUsd"]) for r in warmups)
    return {
        "priceDate": "2026-10-14",
        "pricingAssumption": "Standard short-context Luna API equivalent",
        "actualBilling": None,
        "nativeProviderUsageMultisetsEqual": True,
        "logs": len(logs),
        "spans": len(spans),
        "metrics": len(metrics),
        "logEventCounts": dict(Counter(attributes(r).get("event.name", "unnamed") for r in logs)),
        "commonSpans": dict(Counter(s["name"] for s in spans).most_common(10)),
        "upstreamCompletionCount": len(responses),
        "generatingCompletions": len(generating),
        "warmupCompletions": len(warmups),
        "responses": responses,
        "clientEstimatedUsd": str(client_cost),
        "generatingEstimatedUsd": str(generating_cost),
        "extraGeneratingEstimatedUsd": str(generating_cost - client_cost),
        "warmupNominalUsd": str(warmup_cost),
        "allReportedNominalUsd": str(generating_cost + warmup_cost),
        "limitations": [
            "Warmup usage is reported; its billability is unknown.",
            "Compaction attribution uses this controlled run's operation sequence.",
            "WebSocket response IDs deduplicate provider evidence; OTLP compared by count multiset.",
            "This probe does not establish coverage of every provider HTTP/error/retry path.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = analyze(args.directory)
    destination = args.directory / "telemetry-analysis.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "path": str(destination),
                **{
                    k: v
                    for k, v in result.items()
                    if k not in ("responses", "logEventCounts", "commonSpans", "limitations")
                },
            }
        )
    )


if __name__ == "__main__":
    main()
