# Reproducing the CLI context meter

Concise findings: [Spike 012](../../docs/spikes/012-codex-context-meter.md). This is a small offline analyzer, not another agent wrapper or a paid model probe.

```sh
pnpm --filter @agent-spike/012-codex-context-meter probe
pnpm --filter @agent-spike/012-codex-context-meter probe "$PWD/artifacts/009-codex-turn-telemetry/run-1791818262957"
pnpm --filter @agent-spike/012-codex-context-meter test
pnpm --filter @agent-spike/012-codex-context-meter typecheck
pnpm --filter @agent-spike/012-codex-context-meter build
```

The default input is the successful recorded LIVE 009 run. If captures have been removed or were never generated on this machine, supply another 009 directory; the analyzer does not automatically incur inference charges. Its existing-capture regression test skips when that private artifact is absent. Other tests exercise the pure formula and source-defined edge cases; they are not synthetic model responses.

## Source chain, release 0.162.1

All links below are pinned to release revision `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.

1. Core creates [TokenCountEvent from cached token information](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/mod.rs#L4876). Generated-response usage appends to cumulative totals and replaces `last`; other paths may recompute/replay that state.
2. The app-server [maps the event](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/bespoke_event_handling.rs#L1584) to `thread/tokenUsage/updated`. Its [ThreadTokenUsage type](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1934) carries `total`, `last`, and `modelContextWindow`; it carries no computed percentage.
3. The TUI [handles that same notification](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/protocol.rs#L61) and [copies its fields](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget.rs#L920). [Applying token info](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget.rs#L1122) feeds **last usage** and **runtime window** into the calculation.
4. [The TUI formula](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/token_usage.rs#L43) subtracts 12,000 from both usage and capacity, floors adjusted usage/remaining at zero, divides, clamps, and rounds to a whole percentage. The [core counterpart's rationale](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/protocol.rs#L2471) describes this as user-controllable context, excluding a fixed approximation for always-present instructions. It is not measuring the actual current system/tool prefix.
5. The ordinary [footer renderer](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/bottom_pane/footer.rs#L954) formats the percentage as context left. The [configurable status surface](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/status_surfaces.rs#L754) formats remaining or its complement, used. The [`/status` card](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/status/card.rs#L356) also uses last usage and the same percentage function.

The preserved runtime model catalog lists 272,000 selected context, 872,000 maximum, and 95% effective capacity for both tested models. [ModelInfo](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/openai_models.rs#L516) prefers selected over maximum and applies that percentage with integer division. A configured/model-catalog change can therefore change the meter's denominator; do not substitute a marketing/API maximum or the auto-compaction trigger.

## Unknown state and local estimates

The ordinary footer uses a known notification window, without falling back to configured capacity. If usage exists but the runtime window is unknown, its legacy fallback shows **cumulative total tokens used**, not a percentage. The configurable status line [falls back to configured window](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/status_controls.rs#L405); absent either window it returns 100 unless usage is marked pending. Pending usage hides the percentage. Fresh/default state and a resumed session awaiting usage are therefore not equivalent. `/status` uses the runtime window when token information exists, otherwise configured capacity.

[Core history recomputation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/mod.rs#L4802) can replace `last.total_tokens` with an estimated history size and zero detailed input/output counters while retaining cumulative usage. The [internal context estimate](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/context_manager/history.rs#L917) can additionally estimate locally appended items and earlier reasoning. The footer does not independently run that estimator on every delta: it transforms the latest supplied `last.totalTokens`. The ordinary notification provides no explicit estimated-versus-measured provenance bit.

Thus matching the CLI meter is straightforward; claiming exact instantaneous context occupancy is not. Preserve the raw usage snapshot and label any unadjusted `1 − last/window` display as an estimate. Baseline adjustment affects UI only, never billed-token accounting.

## Validation and provenance

Six tests cover the [release's 12,700-of-13,000 → 30% expectation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/tests/status_and_layout.rs#L58), baseline/rounding/bounds, use of last instead of cumulative totals, unknown-window differences, model-window selection, and replay of six actual live snapshots. These are our tests; the upstream Rust TUI test suite was not run.

Downloaded release-source copies are ignored under `artifacts/012-codex-context-meter/source-release/`. The release and separately checked-out `tui/src/token_usage.rs` have matching SHA-256 `ad4ce706d82377b20dd8433c22325e97f02098b7e2b0de86315292099466d625`. Derived reports contain the original executable/capture hashes, source revisions, selected nonsecret catalog values, CLI-adjusted percentages, and unadjusted estimates. No credentials or complete model catalog identity are copied into reports. Concurrent unrelated source patches do not change which installed executable produced the replay input.
