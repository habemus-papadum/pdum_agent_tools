# 012 — What the CLI's context-remaining meter means

## Question and result

Can an app-server client reproduce the CLI's visible context meter? **Yes: the inputs are already in `thread/tokenUsage/updated`, but the CLI subtracts a fixed 12,000-token display baseline.** It uses `tokenUsage.last.totalTokens` and `tokenUsage.modelContextWindow`, not cumulative usage or uncached-input counts. No separate context-percentage RPC is required.

For a known window greater than 12,000, the release TUI computes:

```text
adjustedWindow = modelContextWindow - 12000
adjustedUsed = max(last.totalTokens - 12000, 0)
remaining = round(100 × max(adjustedWindow - adjustedUsed, 0) / adjustedWindow)
```

The result is clamped to 0–100; windows of 12,000 or fewer return zero. **The baseline is a display convention, not free tokens, a measured prompt size, or a billing exclusion.** Cached tokens still occupy context. The [release implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/token_usage.rs#L9) and [notification-to-widget mapping](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget.rs#L920) establish these exact inputs.

## Replay of existing live evidence

Replaying [Spike 009](009-codex-turn-telemetry.md)'s six real usage snapshots gives:

| Snapshot | `last.totalTokens` | CLI adjusted remaining | Unadjusted `1 − last/window` estimate |
| --- | ---: | ---: | ---: |
| Luna tool iterations and final answer | 10,422 → 10,674 | **100% throughout** | 95.97% → 95.87% |
| First Sol turn | 14,615 | **99%** | 94.34% |
| Second Sol turn | 14,647 | **99%** | 94.33% |

The recorded runtime window was 258,400. The preserved model catalog explains it exactly: Luna and Sol each selected `context_window: 272000` over `max_context_window: 872000`, then applied `effective_context_window_percent: 95`. Thus **272,000 × 95% = 258,400**, before the TUI's separate baseline adjustment. This is the selected Codex runtime window, not the model's maximum API capacity. [Window calculation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L516).

## Interpretation and limits

`total.totalTokens` is cumulative inference accounting; using the final 71,515 total in the meter would incorrectly produce **76% instead of 99%**. `last` normally reflects the most recent completed model response, but core history recomputation can replace it with a local estimate. Additional local/tool items may not yet be represented. Neither display percentage is a continuously exact occupancy measurement. Usage can also wait for tool callbacks to finish, as 009 established.

The ordinary footer, configurable status line, and `/status` share the known-window formula but differ when usage/window information is unavailable; [supporting notes](../../spikes/012-codex-context-meter/README.md) document those states and the full core → protocol → TUI chain. Official docs describe the [status and status-line surfaces](https://learn.chatgpt.com/docs/developer-commands); source inspection establishes the arithmetic.

## Reproduce and validation

```sh
pnpm --filter @agent-spike/012-codex-context-meter probe
pnpm --filter @agent-spike/012-codex-context-meter test
```

`probe` defaults to the existing 009 capture; an alternate absolute capture-directory argument is accepted. It writes a private derived report under `artifacts/012-codex-context-meter/`. **Zero new model calls; incremental cost $0.** This is source-grounded replay, not a newly observed TUI screenshot or a compaction experiment.

Version: installed `codex-cli 0.162.1`, release source `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; the meter source is byte-identical at checkout pin `6c372fbef45f730b6d8aa727b0ec8332365588db`. Inspected 12 October 2026 on macOS arm64 / Node 26.10.0. Typecheck/build and six tests pass, including the upstream 12,700-of-13,000 → 30% expectation and all six live-snapshot replays. Compaction/reset behavior is source-inspected, not newly exercised.
