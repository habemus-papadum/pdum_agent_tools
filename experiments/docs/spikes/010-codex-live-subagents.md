# 010 — Real Sol parents, inherited Sol and explicit Luna children

## Question and result

Can a **real model-driven** Codex app-server turn spawn two subagents, and can a Sol parent explicitly choose Luna for them? **Yes, on installed Codex 0.162.1.** Two live runs used exact `gpt-6-sol` parents at low effort, with no model substitution or synthetic Responses backend. One parent spawned two inherited Sol children; the other emitted explicit `model: "gpt-6-luna"`, `reasoning_effort: "low"` arguments for both children. All four children and both parents completed.

The tasks were intentionally tiny: produce one arithmetic answer and one sorted list. Both parents invoked `collaboration.spawn_agent` twice with `fork_turns: "none"`, waited, and returned both results. The host issued only one `thread/start` and one `turn/start` per run—it did not create the children or inject their outputs.

## Evidence and implications

- **Identity and model:** Level 2 retains the actual emitted spawn arguments, each child's parent/thread headers, and model request/response fields. Every child `response.model` matched its intended exact model. Parent `subAgentActivity` history independently recorded the child models, and persisted child histories linked to their parent and contained completed answers.
- **Observation:** child turn start/completion, item start/completion, assistant deltas, token updates, and thread-status notifications automatically arrived on the existing raw stdio connection. **Child `thread/started` was absent.** No child resume or subscription request was needed in these runs. Source attaches newly created threads to initialized connections; reconnect/multi-client behavior was not retested.
- **Proxy scope:** each parent/child model connection used Responses over WSS through the configured MITM. Neither dropped nor truncated capture records occurred. **TLS interception does not expose every application field:** the spawn `message` payload remained application-encrypted ciphertext, although model/fork arguments and final outputs were readable.
- **Runtime:** source implements local child sessions as Tokio tasks within the app-server, not separately launched Codex CLI processes. Children inherit effective settings unless model/effort or configured role/default overrides intervene. Overrides require available supported models and valid effort; fresh-context override succeeded here, while full-history override behavior was not tested. [Pinned child configuration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/agent/child_config.rs), [session task](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/session/mod.rs#L1018).

## Usage and cost

| Live run | Generating calls | Generating input / cached / output tokens | Generation estimate | Warmup estimate |
| --- | ---: | --- | ---: | ---: |
| Sol parent → two Sol children | 7 | 73,861 / 31,360 / 212 | $0.093394 | $0.055012 |
| Sol parent → two Luna children | 6 | 70,264 / 44,544 / 215 | $0.03244916 | $0.0204738 |

Input includes cached input. Combined **standard API-equivalent estimate: $0.20132896**, including six separately counted non-generating warmups. Actual subscription charges and warmup billability are unknown. Prices checked 12 October 2026: [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). Different parent response counts/cache hits make this a functionality experiment, not a controlled cost benchmark.

## Reproduce and limitations

Run `pnpm --filter @agent-spike/010-codex-live-subagents probe`, then `probe --luna`. These consume live usage and require an existing login plus access to both models. `SPIKE_CODEX_BIN` selects an explicit binary. Isolated HOME/CODEX_HOME, in-memory external access-token auth, process-local CA trust, depth/thread/time/capture/cost limits, and unchanged-source-auth checks protect the developer's normal setup. Model/API integration is real; arbitrary tool egress was not exercised.

Private evidence: `artifacts/010-codex-live-subagents/1791817979214-inherit/` and `artifacts/010-codex-live-subagents/1791818129441-luna/`. Each retains L0/L1/L2 and parent/child histories. The first run's model work succeeded but an initial header-name parsing bug broke postprocessing; a read-only restart recovered all three persisted histories without new inference. Its original error is preserved alongside passing `history-recovery.json` and `verification.json`. The second completed normally. Both pass offline evidence assertions; typecheck and analyzer regression test pass.

Environment: macOS arm64, Node 26.10.0, Python 3.14.7, mitmproxy 12.2.3; installed executable 0.162.1. Separately inspected source pin: `6c372fbef45f730b6d8aa727b0ec8332365588db`. [Supporting notes and exact commands](../../spikes/010-codex-live-subagents/README.md) document protocol IDs, recovery, pricing assumptions, encrypted fields, and untested boundaries.
