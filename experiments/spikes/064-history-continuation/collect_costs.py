"""Re-derive the selected 064/065 estimates from ignored real client captures."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / "experiments/artifacts"


def main() -> None:
    """Read qualification evidence only; submit no provider request."""
    evidence = json.loads((ARTIFACTS / "064-history-continuation/browser-evidence.json").read_text())
    prices = json.loads((ROOT / "typescript/packages/agent-history/src/litellm-snapshot.json").read_text())
    cases = []
    for provider in ("codex", "claude"):
        for case in ("resume", "fork", "interrupt"):
            identity = (
                evidence["interruptions"][provider]["runId"]
                if case == "interrupt"
                else evidence["continuation"][provider][f"{case}RunId"]
            )
            capture = ARTIFACTS / "067-live-session-workspace/runs" / identity
            records = json.loads((capture / "live.json").read_text())["records"]
            submissions = [r for r in records if r["message"].get("type") == "local/user"]
            assert len(submissions) == 1, "This collector qualifies one submitted input per selected run"
            if provider == "codex":
                updates = [r for r in records if r["message"].get("method") == "thread/tokenUsage/updated"]
                before = [r for r in updates if r["seq"] < submissions[0]["seq"]]
                after = [r for r in updates if r["seq"] > submissions[0]["seq"]]
                assert after, "Missing native usage; do not estimate it as zero"
                final = after[-1]["message"]["params"]["tokenUsage"]
                if before:
                    base = before[-1]["message"]["params"]["tokenUsage"]["total"]
                    usage = {key: final["total"][key] - base[key] for key in base}
                    basis = "Native cumulative-counter delta from the observed pre-input baseline"
                elif case == "fork":
                    assert len(after) == 1, "Fork has no pre-input baseline; this check qualifies one response only"
                    usage = final["last"]
                    basis = "Single new response counters; inherited parent totals are excluded"
                else:
                    usage = final["total"]
                    basis = "New conversation's latest native total at interrupted completion"
                counts = {
                    "uncached": usage["inputTokens"] - usage["cachedInputTokens"],
                    "cached": usage["cachedInputTokens"],
                    "created5m": 0,
                    "created1h": 0,
                    "output": usage["outputTokens"],
                }
                model = "gpt-6-luna"
                native_cost = None
            else:
                results = [r["message"] for r in records if r["message"].get("type") == "result"]
                assert len(results) == 1, "Missing/extra SDK results need explicit accounting"
                result = results[0]
                usage = result["usage"]
                models = list(result["modelUsage"])
                assert len(models) == 1, "Multiple models require per-model usage"
                model = models[0]
                one_hour = usage.get("cache_creation", {}).get("ephemeral_1h_input_tokens", 0)
                counts = {
                    "uncached": usage["input_tokens"],
                    "cached": usage["cache_read_input_tokens"],
                    "created5m": usage["cache_creation_input_tokens"] - one_hour,
                    "created1h": one_hour,
                    "output": usage["output_tokens"],
                }
                native_cost = result["total_cost_usd"]
                basis = "Per-turn SDK usage; conversation-cumulative dollars are retained separately"
            assert all(value >= 0 for value in counts.values()), "A counter reset is not negative cost"
            rates = prices["entries"][model]
            cost = sum(
                Decimal(counts[key]) * Decimal(str(rates[rate]))
                for key, rate in (
                    ("uncached", "input_cost_per_token"),
                    ("cached", "cache_read_input_token_cost"),
                    ("created5m", "cache_creation_input_token_cost"),
                    ("output", "output_cost_per_token"),
                )
            )
            if counts["created1h"]:
                cost += Decimal(counts["created1h"]) * Decimal(str(rates["cache_creation_input_token_cost_above_1hr"]))
            cases.append(
                {
                    "provider": provider,
                    "case": case,
                    "runId": identity,
                    "model": model,
                    "counts": counts,
                    "basis": basis,
                    "estimatedUsd": float(cost),
                    "nativeCumulativeUsd": native_cost,
                }
            )
    report = {
        "date": "2026-10-25",
        "priceSnapshot": prices["fetched_at"],
        "cases": cases,
        "estimatedUsd": float(sum(Decimal(str(case["estimatedUsd"])) for case in cases)),
        "billing": "API-equivalent estimate; actual subscription billing and implementation-agent costs unmeasured",
    }
    output = ARTIFACTS / "064-history-continuation/costs.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
