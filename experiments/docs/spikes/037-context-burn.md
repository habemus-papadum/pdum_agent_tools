# 037: Does Astra burn context faster than Fable?

**Question.** Whether GPT-6 Astra at extra-high effort in Codex fills its context faster
than Fable 5.1 at extra-high effort in Claude Code, and whether a large context costs
money or time.

**Result.** The per-step rate is similar and Fable's is higher; the difference is the
window Codex gives Astra (258,400, a served catalog default of 272,000 × 95%, with a
catalog maximum of 872,000 reachable through `model_context_window` in `config.toml`).
A controlled three-arm run of one task confirmed it: Codex filled 36% of the default
window and 11% of the enlarged one with identical behaviour; Claude filled 18% of 1M but
reached twice the absolute context, mostly through its own output. Full write-up in
[docs/context-consumption.md](../../../docs/context-consumption.md).

**How to reproduce.** The historical analysis is `burn.py` and the experiment scripts and
grades are under `experiments/artifacts/037-context-burn/` (local only). The repeatable
form is `experiments/evals/`: `prepare.py`, `run.py`, `ingest.py`, `report.py` with the
three configs that produced the baseline `baselines/launcher-client/2026-10-17.json`.

**Versions.** Codex CLI 0.162.1 (catalog fetched 2026-10-17), Claude Code 2.1.302,
agent-history schema version 4, LiteLLM prices of 2026-10-17.

**Limitations.** One run per arm; clean profiles without the user's plugins and MCP
servers; Codex per-step latency cannot be read from rollouts because unified exec items
complete at process start; neither run reached 200k of context, so the slowdown question
is open.
