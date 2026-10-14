# 032 — Advisory health research

See the [indicator table](../../docs/spikes/032-codex-health.md). The runners use
real model/tool behavior; only the deliberately failing HTTP provider is injected.
`mcp_fixture.py` is a real local stdio MCP server with a timed tool response.
The read-only sandbox is explicit for one fixture; launcher defaults remain
danger-full-access/never. Native profiles and work are created under ignored
artifact directories, never in the ordinary developer home.

```sh
# From experiments/, parent workspace already installed:
uv run --no-project /ABS/ROOT/.venv/bin/python spikes/032-codex-health/probe.py
uv run --no-project /ABS/ROOT/.venv/bin/python spikes/032-codex-health/pending_and_disconnect.py
```

The harness imports the local [028 probe](../028-codex-joins/probe.py) for connection,
profile and evidence handling; no new shared production library is introduced.
Every client message and relay observation is recorded, snapshots and native
rollouts are retained, and each result includes attempts, cumulative usage,
unknown coverage and source-auth hash equality. Process diagnostics are retained
by the existing launcher in `profile/runtime/runs/`. Credentials/raw captures
remain private ignored data. No extra capture truncation/admission limit is added.

| Private artifact directory | Actual work | Observed estimate |
| --- | --- | ---: |
| `artifacts/032-codex-health/1792000511740` | Four local commands (two exit-7 failures), interrupted sleep, denied write, Luna child, idle background terminal, injected HTTP 503 | $0.00567640 |
| `artifacts/032-codex-health/1792000622357` | Pending MCP/read/resume, dynamic callback interruption/late response, zero-client native completion | $0.00196074 |
| `artifacts/028-codex-joins/1792000437132` | Pending human input and resolved-notification race | Counted by 028 only |
| `artifacts/029-codex-forks/run-1792000579846` | Manual compaction, active goal/queue behavior | Counted by 029 only |

All new 032 attempts completed as experiments, including their intentional failed
and interrupted turns. This does not mean every provider turn succeeded. The
interrupted dynamic callback has no usage notification in the recorded stream;
its provider usage remains unknown, not zero. The injected HTTP case used exactly
one local POST and no successful provider response. These local and provider
failure categories must stay separate.

The first run's native denied-write rollout contains a `custom_tool_call` invoking
the real shell and a `custom_tool_call_output` with exit 1 and `Operation not
permitted`. The target file remained absent. Neither live events nor canonical
thread history contained a `commandExecution` item for that attempt. Do not
promote the assistant's explanation into independent sandbox evidence: the
rollout/tool output and explicit fixture policy provide it here.

The child was model-created, not started by the host. Parent `subAgentActivity`
identified Luna/low and `/root/tiny_child`; child history linked `parentThreadId`
and held one completed turn with `CHILD_OK`. The child received its own token
usage (12,669 input, no cache, seven output), separate from parent usage. Child
events arrived automatically on the existing parent connection, without child
resume; no child `thread/started` was needed. This is a tiny functional check,
not a scaling test or proof every reconnect follows descendants.

The no-client case disconnected both clients after command start. Before and
after seven seconds the relay reported zero clients, 112 messages, zero loss and
zero transport errors. A reconnect/read then showed the completed command and
`NO_CLIENT_FINISHED`; resume supplied cumulative usage. No passive relay hook
can observe traffic that app-server never sends to a subscribed connection.
Continuous health needs a deliberate observing connection or another native
observation point, with provenance and stale-state handling.

The compaction evidence was read directly from 029's result and `level1.jsonl`:
`contextCompaction` started/completed, then a completed turn; cumulative total
unchanged, `last.totalTokens` 6,026 while input/output were zero. It establishes
context recomputation, not free compaction or a second bill. Goal and queue
findings are intentionally cross-referenced instead of creating another goal
that could continue autonomously.

Pricing/bounds and version identity follow [028](../028-codex-joins/README.md).
No upstream MITM is used in these runs; estimates only price observed cumulative
usage once per thread. All cache-write counters were zero. Model/effort/tier are
explicit Luna/low/default; all scope expansion remained within the coordinator's
$0.20 allocation. Orchestration-agent token charges are unavailable and excluded,
not asserted to be zero.
