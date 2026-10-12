# 009 — Live turn telemetry and model overrides

## Question and main result

Does raw app-server report token/cache/context information during a turn, and can a host choose the model per thread or turn? **Yes, at model-completion boundaries inside a turn—not token by token. Model overrides are sticky.** A live, subscription-authenticated Codex **0.162.1** run used three sequential host-tool calls, four Luna completions within one turn, then two tiny Sol turns. No synthetic model responses were used.

## Observed telemetry

The Luna turn emitted four `thread/tokenUsage/updated` snapshots before `turn/completed`:

| Model completion | `last.inputTokens` | `last.cachedInputTokens` | `last.outputTokens` | `total.totalTokens` |
| --- | ---: | ---: | ---: | ---: |
| Luna 1 | 10,367 | 1,792 | 55 | 10,422 |
| Luna 2 | 10,464 | 9,984 | 63 | 20,949 |
| Luna 3 | 10,568 | 9,984 | 62 | 31,579 |
| Luna 4 | 10,665 | 9,984 | 9 | 42,253 |
| Sol, explicit next turn | 14,608 | 0 | 7 | 56,868 |
| Sol, model omitted | 14,638 | 14,464 | 9 | 71,515 |

- **`last` matched one upstream completion**, not the whole agent turn. **`total` accumulated across tool iterations, turns, and the model switch**; it is accounting, not context occupancy. Cached input is a subset of input, and reasoning output is a subset of output. Cache-write and reasoning counters were zero here.
- Notifications arrived **after host-tool replies**, 140–184 ms after the corresponding upstream completion in our deliberately delayed callbacks. A waiting tool can delay usage visibility. Text deltas contained text/IDs, not continuously updated usage.
- No identical usage snapshots or extra final repeat were observed. Final `turn/completed` and `thread/read` turn objects contained status, items, and timing, **not a second usage/cost payload**. Preserve the usage notifications yourself.
- The **Codex-reported effective window** (`modelContextWindow`) remained **258,400** for this executable/catalog, not the underlying model's maximum API capacity. `last.totalTokens` increased from 10,422 to 10,674 during the Luna turn; it is only a context proxy, not exact current occupancy after local/tool additions. No compaction, reset, resume, or reconnect was exercised.

## Model selection and cost

Follow-up [Spike 012](012-codex-context-meter.md) traces the CLI's context-remaining display exactly. It subtracts a fixed 12,000-token UI baseline from both usage and capacity: these Luna snapshots therefore display **100%**, not the roughly 96% obtained from a direct `last.totalTokens / modelContextWindow` calculation. This is a display convention, not free tokens or a different billing count.

Process default **Sol → `thread/start.model: Luna` → omitted model on first turn** generated Luna. `turn/start.model: Sol` changed the next turn; omitting model on the third turn still generated Sol. Thread snapshots and `thread/settings/updated` agreed. The switch sent full input without `previous_response_id`; the following Sol call reused the response chain. The observed cache counts do **not** establish a general cache-invalidation rule.

Successful run: **71,310 input / 46,208 cached / 205 output** across six generating responses; one separate Luna warmup reported 9,248 input. At [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) Standard short-context prices checked 12 October 2026: **$0.03406074 generated**, **$0.00092480 warmup equivalent**, **$0.03498554 combined**. Including one aborted paid attempt, all captured completed responses across this spike total **$0.05510806 (5.51¢) API equivalent**, not actual subscription billing. An earlier startup-aborted attempt recorded no completed response; unreported usage cannot be ruled out.

## Reproduce, evidence, and limits

```sh
pnpm --filter @agent-spike/009-codex-turn-telemetry probe
pnpm --filter @agent-spike/009-codex-turn-telemetry analyze "$PWD/artifacts/009-codex-turn-telemetry/run-1791818262957"
```

The bounded runner uses an explicit installed binary (`SPIKE_CODEX_BIN` overrides it), temporary home/cwd outside the repo, in-memory subscription-token injection, and the Spike 004 MITM recorder. Original auth was unchanged. Private L0/L1/L2, snapshots, and analyses are under the successful artifact directory above: **236 WebSocket messages, 1.55 MB L2, zero drops or truncations**. [Supporting notes](../../spikes/009-codex-turn-telemetry/README.md) include exact source anchors, assumptions, failed attempts, and SDK implications.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes model overrides and streaming events. Release-source inspection at `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` explains aggregation and tool-delayed emission; the separately checked-out source is `6c372fbef45f730b6d8aa727b0ec8332365588db`. Environment: macOS arm64, Node 26.10.0, Python 3.14.7, mitmproxy 12.2.3, no SDK. Typecheck/build, two unit tests, and offline L1/L2 accounting assertions pass. This validates selected live paths, not continuous exact context size, billing, compaction behavior, or every telemetry mode.
