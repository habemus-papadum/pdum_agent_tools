"""Research-only accounting and session facts; no transport, clock, credentials, or network."""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

FIELDS = ("inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens")
RATES = {"gpt-6-luna": tuple(map(Decimal, ("0.10", "0.01", "0.125", "0.50")))}
PRICE_SOURCE = "https://developers.openai.com/api/docs/models/gpt-6-luna"


def price(counts: dict, model: str | None) -> str | None:
    """Price disjoint input classes, requiring known counts and a known model."""
    if model not in RATES or any(not isinstance(counts.get(k), int) or counts[k] < 0 for k in FIELDS):
        return None
    input_tokens, cached, written, output = (counts[k] for k in FIELDS)
    if cached + written > input_tokens:
        return None
    uncached = input_tokens - cached - written
    total = sum(Decimal(n) * rate for n, rate in zip((uncached, cached, written, output), RATES[model]))
    return format(total / 1_000_000, "f")


def decode(entry: dict) -> tuple[str, str, dict]:
    message = entry.get("message")
    if message is None:
        payload = entry.get("payload")
        if entry.get("encoding") == "base64" or not isinstance(payload, str):
            return "unknown", "unknown", {}
        try:
            message = json.loads(payload)
        except ValueError:
            return "unknown", "unknown", {}
    return (
        entry.get("direction", "unknown"),
        str(entry.get("connection_id", entry.get("connection", entry.get("client", "default")))),
        message,
    )


class Analysis:
    """Compare observed increments with native cumulative totals without inventing missing history."""

    def __init__(self):
        self.requests = {}
        self.threads = {}
        self.unrecognized = set()

    def thread(self, identifier):
        return self.threads.setdefault(
            identifier,
            {
                "model": None,
                "modelAttribution": "unknown",
                "nativeUsage": None,
                "baseline": None,
                "bornInCapture": False,
                "observedCounts": dict.fromkeys(FIELDS, 0),
                "estimatedUsd": "0",
                "pricedIncrements": 0,
                "unpricedIncrements": 0,
                "seenUsage": set(),
                "issues": set(),
                "items": {},
                "status": None,
            },
        )

    def accept(self, entry: dict):
        direction, connection, message = decode(entry)
        if not isinstance(message, dict):
            return
        method, params = message.get("method"), message.get("params", {})
        if direction in ("client", "client_to_server"):
            if method and "id" in message:
                self.requests[(connection, str(message["id"]))] = (method, params)
                if method == "turn/start" and params.get("threadId"):
                    state = self.thread(params["threadId"])
                    if params.get("model"):
                        state["model"] = params["model"]
                        state["modelAttribution"] = "requested; confirm with provider evidence"
            return
        if direction not in ("server", "server_to_client"):
            return
        if not method and "id" in message:
            request = self.requests.pop((connection, str(message["id"])), None)
            result = message.get("result", {})
            if request and request[0] in ("thread/start", "thread/resume", "thread/fork") and result.get("thread"):
                state = self.thread(result["thread"]["id"])
                if request[0] == "thread/start":
                    state["bornInCapture"] = True
                    if state["baseline"] is None:
                        state["baseline"] = dict.fromkeys(FIELDS, 0)
                if result.get("model"):
                    state["model"] = result["model"]
                    state["modelAttribution"] = "native effective setting; not provider response"
            return
        identifier = params.get("threadId")
        if not identifier:
            return
        state = self.thread(identifier)
        if method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage", {})
            total = usage.get("total", {})
            state["nativeUsage"] = deepcopy(usage)
            if any(not isinstance(total.get(k), int) or total[k] < 0 for k in FIELDS):
                state["issues"].add("incomplete usage counters")
                return
            signature = tuple(total[k] for k in FIELDS)
            if signature in state["seenUsage"]:
                return
            state["seenUsage"].add(signature)
            baseline = state["baseline"]
            if baseline is None:
                state["issues"].add("first snapshot is a baseline; earlier spend or inherited history not attributed")
                state["baseline"] = {k: total[k] for k in FIELDS}
                return
            increment = {k: total[k] - baseline[k] for k in FIELDS}
            if any(value < 0 for value in increment.values()):
                state["issues"].add(
                    "counter decrease: reset/revert/out-of-order unresolved; subsequent accounting incomplete"
                )
                return
            state["baseline"] = {k: total[k] for k in FIELDS}
            for key, value in increment.items():
                state["observedCounts"][key] += value
            amount = price(increment, state["model"])
            if amount is None:
                state["unpricedIncrements"] += 1
                state["issues"].add("unknown pricing or inconsistent disjoint token classes")
            else:
                state["pricedIncrements"] += 1
                state["estimatedUsd"] = str(Decimal(state["estimatedUsd"]) + Decimal(amount))
        elif method == "thread/settings/updated":
            model = params.get("threadSettings", {}).get("model")
            if model:
                state["model"] = model
                state["modelAttribution"] = "native effective setting; not provider response"
        elif method == "thread/status/changed":
            state["status"] = deepcopy(params.get("status"))
        elif method in ("item/started", "item/completed"):
            item = params.get("item", {})
            key = (params.get("turnId"), item.get("id"))
            old = state["items"].get(key)
            if old is None or method == "item/completed":
                state["items"][key] = {
                    "type": item.get("type"),
                    "state": method,
                    "status": item.get("status"),
                    "exitCode": item.get("exitCode"),
                }
        else:
            self.unrecognized.add(method)

    def snapshot(self) -> dict:
        result = {}
        for identifier, state in self.threads.items():
            value = {k: deepcopy(v) for k, v in state.items() if k not in ("seenUsage", "items", "issues", "baseline")}
            value["issues"] = sorted(state["issues"])
            value["items"] = [dict(turnId=k[0], itemId=k[1], **v) for k, v in sorted(state["items"].items(), key=str)]
            value["coverage"] = "observed protocol increments; upstream warmups/retries may be absent"
            result[identifier] = value
        return {
            "threads": result,
            "priceDate": "2026-10-14",
            "priceSource": PRICE_SOURCE,
            "pricingAssumption": "Standard short-context Luna; configured model is not provider attestation",
            "actualSubscriptionBilling": None,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    analysis = Analysis()
    for line in args.capture.read_text().splitlines():
        if line.strip():
            analysis.accept(json.loads(line))
    result = json.dumps(analysis.snapshot(), indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(result)
        print(args.out)
    else:
        print(result)


if __name__ == "__main__":
    main()
