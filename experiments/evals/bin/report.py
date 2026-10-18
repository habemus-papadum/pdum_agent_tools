"""Measure one run from its history file and worktree, then check it against expectations and baselines.

Usage: report.py RUN_ID [--baselines FILE] [--no-checks]
       report.py --make-baseline OUT.json RUN_ID [RUN_ID ...]

Writes ``metrics.json``, ``checks.txt`` and ``report.md`` into the run directory. The metrics come
from the shared agent-history schema only, so any agent that lands its trace there is measured the
same way. Prices are list prices as printed by ``agent-history prices show`` on 2026-10-17.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

import duckdb
from common import load_manifest, now, run_dir, task_dir

PRICES = {  # per million tokens: uncached input, cached input, cache write, output
    "gpt-6-astra": (10.0, 1.0, 12.5, 50.0),
    "gpt-6-sol": (10.0, 1.0, 12.5, 50.0),
    "gpt-6-luna": (10.0, 1.0, 12.5, 50.0),
    "claude-fable-5-1": (10.0, 0.25, 12.5, 50.0),
    "claude-opus-5-5": (4.0, 0.2, 5.0, 20.0),
}
ENVELOPE_METRICS = (
    "wall_minutes",
    "steps",
    "tool_calls",
    "tool_bytes",
    "peak_ctx",
    "growth_per_step",
    "output_tokens",
    "context_read_millions",
    "cost_usd",
)
TOOL_TYPES = "('commandExecution', 'toolCall', 'mcpToolCall', 'webSearch', 'fileChange', 'collabAgentToolCall')"


def scalar(con: duckdb.DuckDBPyConnection, sql: str, *params: Any) -> Any:
    row = con.execute(sql, params).fetchone()
    return None if row is None else row[0]


def measure(manifest: dict[str, Any]) -> dict[str, Any]:
    directory = run_dir(manifest["run_id"])
    db = directory / "history.duckdb"
    if not db.exists():
        raise SystemExit(f"{db} missing; run ingest.py first")
    con = duckdb.connect(str(db), read_only=True)
    main_thread = scalar(
        con,
        "SELECT thread_id FROM responses WHERE origin <> 'copied-context' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
    )
    metrics: dict[str, Any] = {
        "run_id": manifest["run_id"],
        "task": manifest["task"],
        "label": manifest["label"],
        "agent": manifest["agent"],
        "exit_code": manifest.get("exit_code"),
        "main_thread": main_thread,
    }
    if main_thread is None:
        con.close()
        metrics["steps"] = 0
        return metrics
    row = con.execute(
        """
        SELECT count(*), arg_min(input_tokens, rollout_ordinal), max(input_tokens), sum(output_tokens),
               sum(reasoning_output_tokens), sum(input_tokens), sum(cached_input_tokens), min(ts), max(ts),
               mode(model)
        FROM responses WHERE thread_id = ? AND origin <> 'copied-context'
        """,
        [main_thread],
    ).fetchone()
    steps, start_ctx, peak_ctx, output, reasoning, ctx_read, cached, first_ts, last_ts, model = row
    metrics.update(
        steps=steps,
        responses_total=scalar(con, "SELECT count(*) FROM responses WHERE origin <> 'copied-context'"),
        threads=scalar(con, "SELECT count(*) FROM threads"),
        model=model,
        start_ctx=start_ctx,
        peak_ctx=peak_ctx,
        growth_per_step=round((peak_ctx - start_ctx) / max(steps - 1, 1)),
        output_tokens=int(output or 0),
        reasoning_tokens=None if reasoning is None else int(reasoning),
        context_read_millions=round((ctx_read or 0) / 1e6, 2),
        cache_share=round((cached or 0) / max(ctx_read or 1, 1), 3),
    )
    seconds = manifest.get("seconds")
    if seconds is None and first_ts and last_ts:
        seconds = (last_ts - first_ts).total_seconds()
    metrics["wall_minutes"] = None if seconds is None else round(seconds / 60, 1)
    metrics.update(
        tool_calls=scalar(
            con,
            f"SELECT count(*) FROM items WHERE item_type IN {TOOL_TYPES} AND origin IS DISTINCT FROM 'copied-context'",
        ),
        tool_bytes=int(scalar(con, "SELECT COALESCE(sum(output_bytes), 0) FROM items") or 0),
        file_changes=scalar(con, "SELECT count(*) FROM items WHERE item_type = 'fileChange'"),
        failed_commands=scalar(
            con,
            "SELECT count(*) FROM items WHERE item_type = 'commandExecution'"
            " AND (status = 'failed' OR COALESCE(exit_code, 0) <> 0)",
        ),
        compactions=scalar(con, "SELECT count(*) FROM rollout_events WHERE event_type = 'compacted'"),
        ran_tests=bool(
            scalar(
                con,
                "SELECT count(*) FROM items WHERE item_type = 'commandExecution' AND (command ILIKE '%vitest%'"
                " OR command ILIKE '%pnpm test%' OR command ILIKE '%pnpm -r test%' OR command ILIKE '%pnpm run test%')",
            )
        ),
        ran_typecheck=bool(
            scalar(
                con,
                "SELECT count(*) FROM items WHERE item_type = 'commandExecution'"
                " AND (command ILIKE '%tsc%' OR command ILIKE '%typecheck%')",
            )
        ),
    )
    window = scalar(con, "SELECT max(model_context_window) FROM token_counts")
    result_path = directory / "result.json"
    ledger_cost = None
    if result_path.exists():
        try:
            result = json.loads(result_path.read_text())
        except ValueError:
            result = {}
        ledger_cost = result.get("total_cost_usd")
        for usage in (result.get("modelUsage") or {}).values():
            window = window or usage.get("contextWindow")
            metrics["thinking_tokens"] = usage.get("thinkingTokens")
        text = result.get("result") or ""
        metrics["asked_question"] = text.rstrip().endswith("?")
        metrics["result_subtype"] = result.get("subtype")
    window = window or manifest.get("config", {}).get("run", {}).get("window")
    metrics["window"] = window
    metrics["peak_pct_window"] = None if not window else round(100 * peak_ctx / window, 1)
    rates = PRICES.get(str(model))
    if rates:
        uncached, cached_rate, write_rate, output_rate = rates
        list_cost = scalar(
            con,
            f"""
            SELECT sum(greatest(input_tokens - cached_input_tokens - COALESCE(cache_write_input_tokens, 0), 0)
                       * {uncached} + cached_input_tokens * {cached_rate}
                       + COALESCE(cache_write_input_tokens, 0) * {write_rate} + output_tokens * {output_rate}) / 1e6
            FROM responses WHERE origin <> 'copied-context'
            """,
        )
        metrics["cost_usd_list"] = round(list_cost or 0, 2)
    metrics["cost_usd_ledger"] = None if ledger_cost is None else round(ledger_cost, 2)
    metrics["cost_usd"] = metrics.get("cost_usd_ledger") or metrics.get("cost_usd_list")
    con.close()
    return metrics


def run_checks(manifest: dict[str, Any]) -> dict[str, Any]:
    script = task_dir(manifest["task"]) / "checks.sh"
    directory = run_dir(manifest["run_id"])
    completed = subprocess.run(["/bin/zsh", str(script), manifest["worktree"]], text=True, capture_output=True)
    (directory / "checks.txt").write_text(completed.stdout + completed.stderr)
    checks: dict[str, Any] = {}
    for line in completed.stdout.splitlines():
        match = re.match(r"^CHECK (\S+) (ok|FAIL)(?: (.*))?$", line)
        if match:
            checks[match.group(1)] = {"ok": match.group(2) == "ok", "detail": match.group(3) or ""}
    return checks


def check_expectations(manifest: dict[str, Any]) -> dict[str, Any]:
    path = task_dir(manifest["task"]) / "expectations.json"
    if not path.exists():
        return {}
    spec = json.loads(path.read_text())
    package = Path(manifest["worktree"]) / spec["package_dir"]
    corpus = ""
    for sub in spec.get("search", ["src", "test"]):
        for file in sorted((package / sub).rglob("*")) if (package / sub).exists() else []:
            if file.is_file() and file.suffix in {".ts", ".tsx", ".js", ".mjs", ".json", ".md"}:
                corpus += file.read_text(errors="replace") + "\n"
    coverage = {}
    for group, needles in spec.get("must_contain", {}).items():
        missing = [needle for needle in needles if needle not in corpus]
        coverage[group] = {"found": len(needles) - len(missing), "total": len(needles), "missing": missing}
    return {"package_exists": package.is_dir(), "coverage": coverage, "spec": spec}


def flags_for(
    metrics: dict[str, Any], checks: dict[str, Any], expectations: dict[str, Any], baselines: dict | None
) -> list[str]:
    flags: list[str] = []
    if metrics.get("exit_code") not in (0, None):
        flags.append(f"FAIL exit code {metrics['exit_code']}")
    for name, result in checks.items():
        if not result["ok"]:
            flags.append(f"FAIL check {name}: {result['detail']}".rstrip(": "))
    if metrics.get("asked_question"):
        flags.append("FAIL the agent ended with a question instead of a result")
    for group, cover in expectations.get("coverage", {}).items():
        if cover["missing"]:
            level = "FAIL" if group == "routes" else "WARN"
            flags.append(f"{level} {group}: missing {', '.join(cover['missing'])}")
    spec = expectations.get("spec", {})
    tests = checks.get("test", {}).get("detail", "")
    count = int(tests.split()[0]) if tests[:1].isdigit() else None
    if count is not None and count < spec.get("min_tests", 0):
        flags.append(f"WARN only {count} tests; the task expects at least {spec['min_tests']}")
    if metrics.get("steps") and not metrics.get("ran_tests"):
        flags.append("WARN no test run found in the transcript; the agent may not have verified its work")
    if baselines:
        envelope = baselines.get("envelope", {})
        for name in ENVELOPE_METRICS:
            value = metrics.get(name)
            bounds = envelope.get(name)
            if value is None or not bounds:
                continue
            low, high = bounds
            if value < 0.5 * low or value > 2 * high:
                flags.append(f"WARN {name} = {value} is outside half-to-double the baseline range [{low}, {high}]")
        ok = all(result["ok"] for result in checks.values()) if checks else False
        if ok and ((metrics.get("steps") or 0) < 10 or (metrics.get("wall_minutes") or 0) < 4):
            flags.append(
                "TOO GOOD all gates pass with very few steps or minutes; confirm the agent ran the gates itself"
            )
    return flags


def render(
    manifest: dict[str, Any],
    metrics: dict[str, Any],
    checks: dict[str, Any],
    expectations: dict[str, Any],
    baselines: dict | None,
    flags: list[str],
) -> str:
    lines = [f"# Eval run {manifest['run_id']}", ""]
    lines.append(
        f"Task `{manifest['task']}`, agent `{manifest['agent']}`, label `{manifest['label']}`, measured {now()}."
    )
    lines.append(f"Worktree `{manifest['worktree']}`; raw data under `{run_dir(manifest['run_id'])}`.")
    lines.append("")
    lines.append("| Metric | This run | Baseline low | Baseline high |")
    lines.append("| --- | ---: | ---: | ---: |")
    envelope = (baselines or {}).get("envelope", {})
    rows = [
        *ENVELOPE_METRICS,
        "peak_pct_window",
        "window",
        "file_changes",
        "failed_commands",
        "compactions",
        "cache_share",
        "cost_usd_list",
        "cost_usd_ledger",
    ]
    for name in rows:
        bounds = envelope.get(name)
        low = "" if not bounds else bounds[0]
        high = "" if not bounds else bounds[1]
        value = metrics.get(name)
        lines.append(f"| {name} | {'' if value is None else value} | {low} | {high} |")
    lines.append("")
    lines.append("## Gates")
    lines.append("")
    for name, result in checks.items():
        lines.append(f"- {name}: {'ok' if result['ok'] else 'FAIL'} {result['detail']}".rstrip())
    if not checks:
        lines.append("- (checks not run)")
    lines.append("")
    lines.append("## Expectations")
    lines.append("")
    for group, cover in expectations.get("coverage", {}).items():
        missing = f" (missing: {', '.join(cover['missing'])})" if cover["missing"] else ""
        lines.append(f"- {group}: {cover['found']}/{cover['total']}{missing}")
    lines.append("")
    lines.append("## Flags")
    lines.append("")
    lines.extend(f"- {flag}" for flag in flags) if flags else lines.append("- none")
    lines.append("")
    lines.append("## Rubric (score each 0 to 3 after reading the worktree)")
    lines.append("")
    lines.append("1. Route coverage: every route and the WebSocket helper, with the right verbs and status handling.")
    lines.append("2. Type fidelity: field names and nullability match the Python handlers, not the docs.")
    lines.append("3. Tests: meaningful assertions against a mocked fetch, not only happy paths.")
    lines.append("4. Gates: lint, typecheck, tests and build pass without weakening configuration.")
    lines.append("5. README: a reader can use the package from it alone.")
    lines.append("6. Scope: no unrequested edits outside the package beyond workspace wiring (subtract for each).")
    lines.append("")
    base = run_dir(manifest["run_id"])
    lines.append(f"Evidence: `{base / 'worktree.patch'}`, `{base / 'status.txt'}`, `{base / 'checks.txt'}`.")
    return "\n".join(lines) + "\n"


def make_baseline(out: Path, run_ids: list[str]) -> None:
    runs = []
    for run_id in run_ids:
        metrics_path = run_dir(run_id) / "metrics.json"
        if not metrics_path.exists():
            raise SystemExit(f"{metrics_path} missing; run report.py {run_id} first")
        runs.append(json.loads(metrics_path.read_text()))
    envelope = {}
    for name in ENVELOPE_METRICS:
        values = [run[name] for run in runs if run.get(name) is not None]
        if values:
            envelope[name] = [min(values), max(values)]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"task": runs[0]["task"], "generated_at": now(), "runs": runs, "envelope": envelope},
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    print(f"baseline from {len(runs)} runs written to {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_ids", nargs="+")
    parser.add_argument("--baselines", type=Path, help="baseline JSON to compare against")
    parser.add_argument("--no-checks", action="store_true", help="skip the task's checks.sh (slow: installs and tests)")
    parser.add_argument(
        "--make-baseline", type=Path, metavar="OUT", help="write a baseline envelope from the given runs"
    )
    args = parser.parse_args()
    if args.make_baseline:
        make_baseline(args.make_baseline, args.run_ids)
        return
    if len(args.run_ids) != 1:
        parser.error("report one run at a time unless --make-baseline is given")
    manifest = load_manifest(args.run_ids[0])
    directory = run_dir(manifest["run_id"])
    metrics = measure(manifest)
    checks = {} if args.no_checks else run_checks(manifest)
    expectations = check_expectations(manifest)
    baselines = json.loads(args.baselines.read_text()) if args.baselines else None
    flags = flags_for(metrics, checks, expectations, baselines)
    metrics["checks"] = checks
    metrics["expectations"] = {k: v for k, v in expectations.items() if k != "spec"}
    metrics["flags"] = flags
    (directory / "metrics.json").write_text(json.dumps(metrics, indent=2, sort_keys=True, default=str) + "\n")
    report = render(manifest, metrics, checks, expectations, baselines, flags)
    (directory / "report.md").write_text(report)
    print(report)


if __name__ == "__main__":
    main()
