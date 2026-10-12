# Live turn telemetry and model selection

Question and concise result: [Spike 009 summary](../../docs/spikes/009-codex-turn-telemetry.md).

## Run and inspect

```sh
pnpm --filter @agent-spike/009-codex-turn-telemetry probe
pnpm --filter @agent-spike/009-codex-turn-telemetry analyze "$PWD/artifacts/009-codex-turn-telemetry/run-1791818262957"
pnpm --filter @agent-spike/009-codex-turn-telemetry test
pnpm --filter @agent-spike/009-codex-turn-telemetry typecheck
pnpm --filter @agent-spike/009-codex-turn-telemetry build
```

The live runner makes three turns, normally six generated model responses, plus a connection warmup. The first uses Luna and a real host-provided `telemetry_step` tool; the next two are deliberately short Sol replies to demonstrate a different model and stickiness. It has a 180-second deadline, at most 12 tool attempts, bounded capture/message buffers, and a $0.15 API-equivalent check between turns. These are probe bounds, not a prepaid provider spending limit. It does not silently substitute models. Offline `analyze` makes no API calls.

Subscription authentication is read from the developer's existing `auth.json` into process memory, passed through `account/login/start`, and redacted in recordings. No credentials are copied into the isolated profile, and the source file hash must remain unchanged. The capture retains decrypted semantic HTTP/WebSocket data, not original packets or encrypted frame bytes. Credentials are redacted; archive size limits remain relevant. Temp profiles and ignored artifacts contain private conversation data and must not be published.

`level0.json` records the executable hash, version, argv, controlled environment, and limits. `level1.jsonl` records bidirectional raw app-server objects and timestamps; `level2.jsonl` records the MITM observations. `result.json` contains snapshots taken before/after turns and during outstanding callbacks. `analysis.json` correlates response IDs, models, usage, cumulative snapshots, and estimated costs. The recorder itself is reused unchanged from Spike 004/002.

## What one live run established

Successful capture: `artifacts/009-codex-turn-telemetry/run-1791818262957/`, 12 October 2026.

The normal notification surface produced six `thread/tokenUsage/updated` messages, one per generated completion, and six associated account-rate-limit updates. Four completion/usage pairs belonged to the same Luna turn. The host answered three dynamic-tool callbacks; random challenges required each successful tool step to consume the preceding result. These were ordinary tool results, not mocked model responses. The successful run had no rejected tool calls.

The app-server stream is not a continuously updating token counter. Thirteen assistant-text delta messages across all three turns had no usage field. The first three usage updates in the Luna turn arrived 140–184 ms after the upstream completion, after the host supplied each tool result. Tool callbacks were intentionally held for 150 ms. The final usage update preceded `turn/completed` by 3 ms; the two short Sol turns similarly emitted usage 2–4 ms before completion. No extra usage snapshot was embedded in final turn objects or returned thread history.

`last` represented the latest upstream response. `total` exactly equaled the sum of the six generated responses, including repeatedly supplied/cached input. It did not reset at a turn boundary or model switch. The warmup response had input usage at Level 2 but contributed nothing to Level 1 totals. Cost therefore needs an explicit policy for warmups rather than indiscriminately treating every `response.completed` as billed inference.

The runtime advertised `modelContextWindow: 258400` for both tested models. Four Luna `last.totalTokens` readings were 10422, 10527, 10630, and 10674, while cumulative total reached 42253. Dividing cumulative usage by the window would falsely turn repeated inference accounting into context occupancy. The last-response number is closer but still excludes subsequently appended local context and tool output, and can be replaced by a local estimate after history transformations. It is not a universal exact context-size gauge.

The configured process model was Sol; the newly created thread explicitly selected Luna, and a first turn without a model used Luna. A subsequent `turn/start` selected Sol and emitted `thread/settings/updated` with Sol. The following turn omitted model and still used Sol. Initial/final `thread/read.thread.model`, actual upstream request `model`, and response `model` agreed. Turn-level model overrides are not automatically restored afterward: a caller wanting a one-off switch must explicitly switch back. Historical turn objects did not carry a model field; a thread's current model cannot reconstruct an earlier turn's model. This run did not test a model change during an already-active turn.

The first Sol generation sent 17 full input items without a previous response ID, versus one incremental input item for subsequent chained requests. That Sol completion reported zero cached input; the next reported 14464 cached input. These are observations from one run, not proof that every model switch invalidates caches or that all reuse is caused by WebSocket chaining.

## Release-source anchors

The executable is installed `codex-cli 0.162.1`; its release revision is `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. The separately pinned local checkout is `6c372fbef45f730b6d8aa727b0ec8332365588db`; do not conflate them. Copies of the inspected release files are ignored under `artifacts/009-codex-turn-telemetry/source-release/`.

- [TokenUsageInfo aggregation, release protocol.rs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/protocol.rs#L2305): append adds each response to `total_token_usage` and replaces `last_token_usage`. Context-window exhaustion has a special replacement path; cumulative monotonicity is not universal under every event.
- [Completion handling, release turn.rs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/turn.rs#L2933): rate-limit events are recorded with emission deferred, explicitly to avoid duplicate token-count events. Completed responses record usage. [Later in the same function](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/turn.rs#L3156), pending tools drain before the token-count event is sent.
- [Event translation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/bespoke_event_handling.rs#L1584): the core usage snapshot becomes `thread/tokenUsage/updated` with thread and turn IDs; rate-limit state becomes its own notification. The usage notification lacks an upstream response ID, so the matching in this spike uses captured usage and order, not a guaranteed public join key.
- [Local recomputation and other emission paths](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/mod.rs#L4802): recomputation can replace `last` with an estimated `total_tokens` while detailed counters are zero. Other paths can emit cached snapshots, including rate-limit updates and restoration. Treat snapshots as replaceable state, not additive events. The successful live run did not exercise these paths or produce duplicates.
- [Context estimation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/context_manager/history.rs#L917): the runtime adds estimated tokens for items after the latest model-generated item and, depending on server accounting, prior reasoning. [Usable window selection](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/turn_context.rs#L754) uses runtime model information; the observed value is not a claim about the model's maximum API context.
- [Thread model selection](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L1199) builds thread-specific config overrides. [Turn override processing](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/turn_processor.rs#L818) creates persistent thread-settings overrides. `collaborationMode` can take precedence over the model field; it was not set in this experiment.

An internal raw-response completion notification also exists in release source, gated by raw-event plumbing; it was not enabled or tested. It is not part of the ordinary stable inventory used here, and it is not a substitute for complete HTTP/transport capture. No claim about its availability follows from this experiment.

## Attempts and cost ledger

Rates checked against official [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) model pages on 12 October 2026. Per million input/cached/cache-write/output tokens: Luna $0.10/$0.01/$0.125/$0.50; Sol $2/$0.20/$2.50/$10. Calculation uses uncached input = input − cached − cache-write; reasoning is already included in output. The run used Standard service tier and short contexts.

| Attempt | Result | Generated equivalent | Warmup equivalent |
| --- | --- | ---: | ---: |
| `run-1791818074214` | Aborted on a transient empty-rollout `thread/read` error before any completed response was captured | $0 recorded | $0 recorded |
| `run-1791818157816` | Strict harness aborted when Luna speculatively batched dependent tool calls | $0.00130652 | $0.01881600 |
| `run-1791818262957` | Three completed turns; all evidence assertions passed | $0.03406074 | $0.00092480 |
| **Total captured completions** | **$0.05510806 (5.51¢)** | **$0.03536726** | **$0.01974080** |

The first attempt also used a cwd under repo artifacts, so ancestor instructions were not fully isolated; subsequent attempts used an external temporary cwd/home. The runner now records a failed early snapshot as an observation rather than terminating paid work, and accepts recoverable tool validation errors within a strict attempt limit. The successful run had neither issue. Uncompleted requests may have unreported usage; subscription invoices and warmup billing are not established by these estimates.

## SDK implications

Maintain a latest-usage snapshot per thread and attribute accounting differences to turns while explicitly detecting resets/replays; do not sum repeated cumulative snapshots or call `last` a turn total. Store raw events for later reconciliation. Keep textual/tool progress separate from cost visibility. At turn completion, persist the last snapshot you have rather than expecting usage inside the final turn object. Model selection belongs to mutable thread state even when supplied through `turn/start`; track the effective settings notification and explicitly restore a temporary override. Expose context occupancy as an estimate with provenance, not as cumulative billed tokens.
