# 032 — Health, waiting and swarm evidence

**Observed, 14 October 2026:** native events support useful advisory health, but
transport connectivity, a turn's status and the environment's outstanding work
are separate facts. A real command continued after its parent turn completed and
status became idle. A real read-only sandbox denial was absent from command items
in both the live stream and `thread/read`; its native rollout retained the call,
exit code and denial output. A relay-only dashboard cannot claim complete tool
failure counts or continuous observation without subscribers.

| Indicator | Evidence and scope | Confidence and limitation |
| --- | --- | --- |
| Tool count/failure rate | `commandExecution` items, stable item ID, status/exitCode | Observed four local commands, two deliberate exit-7 failures: 2/4 of visible commands. Missing denied calls mean this is not all attempted tools. |
| Repeated-call suspicion | Same command/arguments twice, separate item IDs | Observed; a heuristic only. These repetitions were intentional, not a stuck loop. |
| Slow healthy execution | Started command/MCP item, elapsed time, completion/duration | Observed sleep-3 success and 4,006 ms local MCP call. No text during them did not mean stalled work. |
| Sandbox denial | Native rollout tool result: exit 1 and `Operation not permitted`; file absent under explicit read-only policy | Observed locally on macOS. Live/history command item missing. Dedicated native telemetry can supply stronger classification; error text alone is not a universal denial detector. |
| Pending human input | `item/tool/requestUserInput`, request ID, `waitingOnUserInput`, `serverRequest/resolved` | Observed in 028, including late join and competing responders. |
| Pending dynamic/MCP tool | Unresolved callback or `mcpToolCall` in progress, recovered by resume | Observed. `activeFlags` remained empty; `thread/read` omitted pending items. Dynamic completion/interruption did not emit `serverRequest/resolved`. |
| Interruption | `turn/completed` with `status: interrupted` | Observed; a started command had no matching completion item in that stream. Do not treat missing exit data as success. |
| Provider failure/retry | `error.willRetry`, `codexErrorInfo`, failed turn, `systemError` | Injected one local HTTP 503 with retries zero: `httpConnectionFailed.httpStatusCode=503`, `willRetry=false`. This tests handling, not real upstream failure compatibility. Retry=true is source/schema evidence only here. |
| Transport loss | Connection closure and observation timestamp, separately from thread state | Observed zero clients while native work completed; relay captured no messages during the interval. State becomes stale/unknown, not stopped. |
| Context pressure/compaction | `tokenUsage.last`, `modelContextWindow`, `contextCompaction` items | Reused 029 real compaction: changed `last.totalTokens=6026` with input/output zero and unchanged cumulative usage. Pressure is an estimate; this is not a fresh billable-response count. |
| Cache/cost rate | Unique per-thread cumulative counters and known price/model/tier | Observed cached input; all cache writes zero. Windowed deltas are estimates; warmups and interrupted unreported usage unknown. Never sum repeated cumulative snapshots. |
| Children | `subAgentActivity.agentThreadId`, child turn/item/usage events, child `parentThreadId` | Observed exact Luna parent spawning one Luna/low child, both complete. Parent usage excluded child usage; sum distinct observed threads once. |
| Idle with remaining work | `thread/backgroundTerminals/list`, `thread/queue/list`, `thread/goal/get` | Observed idle parent with one live background terminal; queue empty and goal null. 029 also observed automatic goal continuation on cold resume and queue-triggered turns. |

Representative sequence, with IDs abbreviated:

```json
{"method":"item/started","params":{"threadId":"T","turnId":"U","item":{"type":"commandExecution","id":"I","status":"inProgress"}}}
{"method":"thread/status/changed","params":{"threadId":"T","status":{"type":"idle"}}}
{"method":"turn/completed","params":{"threadId":"T","turn":{"id":"U","status":"completed"}}}
{"id":"A:19","method":"thread/backgroundTerminals/list","params":{"threadId":"T"}}
{"id":"A:19","result":{"data":[{"itemId":"I","processId":"17942","command":"/bin/sh -c \"sleep 15; printf BACKGROUND_DONE\"","osPid":null,"cpuPercent":null,"rssKb":null}],"nextCursor":null}}
```

The terminal was explicitly cleaned afterward. Its opaque `processId` is not an
OS PID; the API returned no CPU/RSS values. A safe-to-suspend decision needs more
than `turn/completed`; these checks justify advisory evidence, not automatic
intervention.

**Source-inspected:** [sandbox denial handling](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L434)
returns tool output without a live process;
[native sandbox telemetry](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/orchestrator.rs#L401)
is an additional observation point. [Human waiting](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/bespoke_event_handling.rs#L829)
uses an explicit status guard. [Active-thread lifetime](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L59)
does not end merely because clients disconnect.

Reproduce from `experiments/` using
`uv run --no-project /ABS/ROOT/.venv/bin/python spikes/032-codex-health/probe.py`
and `pending_and_disconnect.py`. Six plus three explicit turn attempts, one child,
32-tool and 480-second bounds per run, exact `gpt-6-luna`, no fallback, isolated
profiles and unchanged ordinary credentials. Reported usage estimates were
$0.00567640 and $0.00196074 at [14 October Luna Standard prices](https://developers.openai.com/api/docs/models/gpt-6-luna);
these exclude unknown warmups/unreported usage and are not subscription billing.
Compaction/goal evidence is reused, not charged again. [Evidence, commands and
limits](../../spikes/032-codex-health/README.md).

Installed binary 0.162.1, SHA-256 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`,
macOS arm64/Python 3.14.7. Source pin `6c372fb…` is distinct from the release
revision. Linux denial/process behavior, real upstream retries, large swarms,
MCP human elicitation and universal tool visibility remain unqualified.
