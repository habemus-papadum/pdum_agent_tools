"""Summarize all recorded 068 model runs without making any provider request."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from no_model import ARTIFACTS

ROOT = Path(__file__).resolve().parents[3]


def main():
    snapshot = json.loads((ROOT / "typescript/packages/agent-history/src/litellm-snapshot.json").read_text())
    runs = []
    for path in sorted(ARTIFACTS.glob("*/report.json")):
        report = json.loads(path.read_text())
        if "reportedCostUsd" not in report:
            continue
        count = len(report["inputs"]) if isinstance(report["inputs"], list) else report["inputs"]
        per_turn = []
        for session in report["sessions"]:
            for result in session["results"]:
                models = list(result["modelUsage"])
                assert len(models) == 1
                model = models[0]
                rates = snapshot["entries"][model]
                usage = result["usage"]
                one_hour = usage.get("cache_creation", {}).get("ephemeral_1h_input_tokens", 0)
                counters = {
                    "uncached": usage["input_tokens"],
                    "cacheRead": usage["cache_read_input_tokens"],
                    "cacheCreate1h": one_hour,
                    "cacheCreate5m": usage["cache_creation_input_tokens"] - one_hour,
                    "output": usage["output_tokens"],
                }
                estimate = sum(
                    Decimal(counters[key]) * Decimal(str(rates[rate]))
                    for key, rate in (
                        ("uncached", "input_cost_per_token"),
                        ("cacheRead", "cache_read_input_token_cost"),
                        ("cacheCreate1h", "cache_creation_input_token_cost_above_1hr"),
                        ("cacheCreate5m", "cache_creation_input_token_cost"),
                        ("output", "output_cost_per_token"),
                    )
                )
                per_turn.append(
                    {
                        "session": session["id"],
                        "resultId": result["uuid"],
                        "model": model,
                        "counts": counters,
                        "estimatedUsd": float(estimate),
                        "nativeCumulativeUsd": result["total_cost_usd"],
                        "isError": result["is_error"],
                    }
                )
        estimate = sum(Decimal(str(t["estimatedUsd"])) for t in per_turn)
        assert abs(estimate - Decimal(str(report["reportedCostUsd"]))) < Decimal("0.000000001")
        runs.append(
            {
                "run": path.parent.name,
                "inputs": count,
                "harnessStatus": report["status"],
                "harnessFailure": report["failure"],
                "turns": per_turn,
                "estimatedUsd": float(estimate),
            }
        )
    summary = {
        "date": "2026-10-25",
        "priceSnapshot": snapshot["fetched_at"],
        "runs": runs,
        "inputs": sum(r["inputs"] for r in runs),
        "estimatedUsd": float(sum(Decimal(str(r["estimatedUsd"])) for r in runs)),
        "basis": "Per-result usage; cumulative native dollars are not summed within a session. "
        "Actual subscription billing and implementation-assistant cost are unmeasured.",
    }
    (ARTIFACTS / "costs.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
