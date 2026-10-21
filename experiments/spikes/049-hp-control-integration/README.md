# HP dynamic-control integration

This final source-parity pass combines the [046 feature inventory](../046-hp-power-user-audit/README.md),
[047 runtime refactor](../047-hp-dynamic-control/README.md), and
[048 provider edge fixes](../048-hp-steering-edges/README.md). It qualifies their
composition without introducing a production library.

## Observed live checks

On 18 October 2026, six small real `gpt-6-luna` responses passed three Node cases:

1. The model called the actual `wait_agent` tool. A host-injected agent note woke
   it and the next response was `MAIL_OK`.
2. The model waited again. A user steer woke the wait without cancelling another
   agent, and the next response was `STEER_OK`.
3. A waiting turn was interrupted and settled. Its missing tool result was recorded
   as an explicit interrupted outcome. A new turn on that same thread opened a
   fresh model connection and returned `RECOVERED`.

This establishes actual provider acceptance of the repaired context and the
mail/steer continuation path. The note sender in this probe is host-controlled;
it is not a claim that this test model autonomously generated the note.

The existing inventory-dashboard demonstration was then rebuilt with the new
core and rerun in actual Chrome 155. The parent model spawned a child, the child
read application data, and the parent waited and annotated **41**. Two histories,
four tools and six model responses were recorded. The six outgoing browser
requests verified against actual AIUI prompt records. This is new live evidence
for the refactored browser core, separate from the earlier 045 run.

## Portable edge cases and client behavior

`src/scenarios.ts` executes unchanged in Node and a real browser Worker. It checks
queue-only idle mail, message-before-wait, FIFO followup consumption, child cwd
inheritance, retained idle completion, timeout, steer-wake, thread/subtree
interruption and late noncooperative tool outcomes. The Worker also runs 047's
portable race suite unchanged. Those model events are scripted: these checks
test runtime mechanics, not provider compatibility.

`src/protocol.test.ts` uses real Node MessagePorts and verifies two clients can
observe the same agent, a failed renderer does not break the other client,
detaching a view does not interrupt execution, invalid envelopes/send failures
are explicit, and rejected async observers are recorded. An observer that never
resolves does not block agent execution. The final 047 checks additionally cover
interruption during request preparation and before a tool actually starts.

The protocol adapter exposes distinct experimental control operations:

| Extension | Meaning |
| --- | --- |
| `hp/agent/sendMessage` | Queue a note; idle recipient remains idle. |
| `hp/agent/followupTask` | Start an idle child task or deliver explicit work to an active child. |
| `hp/agent/waitAgent` | Observe caller activity/timeout without consuming messages. |
| `hp/agent/interrupt` | Explicit thread or subtree scope. |
| `hp/inputs/read` | Inspect queued, locally included, sent, committed, rejected or uncommitted input. |

These are HP extensions, not claims that native Codex implements identically named
RPCs. Model-facing `send_message`, `followup_task`, `wait_agent` and
`interrupt_agent` follow selected native-v2 meanings through public function-tool
framing. Legacy prototype helpers remain for prior spike examples.

## Run

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/047-hp-dynamic-control test
pnpm --filter @agent-spike/048-hp-steering-edges test
pnpm --filter @agent-spike/049-hp-control-integration test
pnpm --filter @agent-spike/049-hp-control-integration typecheck
pnpm --filter @agent-spike/049-hp-control-integration build
HP_PUBLIC_ROOT="$PWD/spikes/049-hp-control-integration/dist" \
  node spikes/040-hp-integration/dev-server.mjs
```

Open the printed URL and select **Run control checks**. This page has no provider
credentials and makes no model calls. The static server remains foreground; stop
it with Ctrl-C. `window.runHPControls()` runs the same suite and returns results.

For the explicitly paid Node cases, using an existing ignored `.env`:

```sh
node --env-file=../.env --import tsx spikes/049-hp-control-integration/live.mjs --live
```

The probe supplies six-request, 512-output-token and 120-second bounds, Luna only,
reasoning `none`, default service and no retries. Those limits belong to the
probe host; they are not runtime policy. For the browser provider regression,
follow the [045 browser instructions](../045-hp-behavior/README.md#model-selected-application-delegation).
No account or credential strategy was changed by this round.

## Evidence and costs

| Evidence | Location under ignored `experiments/artifacts/` | Result |
| --- | --- | --- |
| Node live controls | `049-hp-control-integration/live-1792343890452/` | Six usage-bearing responses; USD 0.000704200 estimate. |
| Real browser control checks | `049-hp-control-integration/browser-controls-final.json` | Same portable control suites, zero provider calls. |
| Browser live delegation | `049-hp-control-integration/browser-live.json` | Correct annotation, two completed agents and actual prompt verification. |
| Browser provider ledger | `040-hp-integration/browser-1792343997864/ledger.json` | Six responses; USD 0.000841860 estimate. |

**Third-round reported-usage estimate: USD 0.001546060.** The source audit and
local fault peers made no paid calls. This is a dated token-price estimate, not
actual billing; coordinating/research-agent costs are unavailable. Rates are the
18 October 2026 Luna standard rates recorded in each ledger. Earlier rounds'
estimates remain separately recorded rather than overwritten.

Versions: Node 26.10.0, Chrome 155.0.0.0, pnpm 11.9.0, TypeScript 7.0.2,
OpenAI 7.38.0; Codex reference `6c372fbef45f730b6d8aa727b0ec8332365588db`, installed
0.163.0 only for 046's separately labeled raw pipe check. No new production
package, Git commit, push or release is part of this experiment.

## What this does not establish

The inventory intentionally preserves unimplemented contracts: native yielded-job
lifetime and Ctrl-C behavior, parallel tool scheduling, dynamic per-step tool
snapshots, human/MCP request arbitration, richer child settings, user submission
queue APIs, durable recovery and goals. Tool-batch steering is still consumed at
the batch boundary; there is no arbitrary priority insertion API. Noncooperative
host work can continue after local interruption, and upstream work may outlive a
closed socket. Late results are evidence, not permission to repeat side effects.

See the [overall parity report](../../../docs/hp-agent-parity.md) for priorities,
source-aligned module ownership and remaining decisions.
