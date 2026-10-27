# Owned live-session workspace

**25 October 2026 — disposable working study, ready for review.**
The user selected a deliberately narrow starting point: launch new Codex and
Claude sessions through our existing launchers, in two lab profile directories,
and compare the live conversation with the same session's native saved history.
External discovery/attachment remains deferred. The closing 064/065 studies now
extend this same page with native history continuation and explicit lifecycle controls.

## Working experience

Open `/session-lab/` in the shared preview. Choose Codex/Luna or Claude/Haiku,
select an existing working directory, and explicitly launch a session. Send
starts a new turn while idle. Live, Saved history and Compare use the same
transcript presentation. Native source remains inspectable; missing fields do
not become zero or invented lifecycle information. The ordinary UI never sends
a prompt merely because a page is opened.

The initial working directory contains a small real `sample.txt`. It is useful
for asking either agent to read a file and observing a tool call. Other existing
working directories can be selected for operator-driven work.

The compact surface includes interrupt, client disconnect, End runtime and an
owned-runtime drawer with targeted End and End-all actions. **Saved sessions**
reads the native lab catalogue; inspect, choose Resume latest or an exact native
fork boundary, then open a live continuation with the draft still unsent. The
study does not implement steering/queue policy, interactive callback forms,
arbitrary reconnection or external session attachment. A server callback the
Codex client cannot handle receives an explicit unsupported error. Neither
provider is given a fictional successful response.

## Ownership and existing infrastructure

| Concern | Owner in this study |
| --- | --- |
| Codex profile | Existing `create_profile(ProfileSpec(...))`, fresh native configuration plus an explicit auth-only copy from the ordinary login. No source settings, agents, skills or sessions are imported. |
| Codex runtime | Existing foreground `launch()` context and relay. Browser JSON-RPC starts its own thread and submits turns. |
| Claude profile | Existing profile API, separate native configuration root, per-run selected working directory. |
| Claude authentication | Operator-supplied 066 setup-token file, resolved at allocation and injected into the worker through existing launch options. |
| Claude conversation | Official browser Agent SDK owns the query; Python owns the native process and byte relay. |
| Native history | Codex public read/page methods; Claude official history helpers. No resume, fork or private recovery parsing. |
| View computation | Provider-specific pure projections with raw records retained; common message/tool presentation. Existing 059 native-history projection and Markdown interpretation are reused where suitable. |

The small Python service is owned by the preview process. Importing the adapter
or fetching configuration starts no provider worker. Explicit launch invokes the
provider library. Closing the shared preview cleans up its owned live runs. This
is not a new production coordinator or a separate provider daemon.

Codex's runtime can outlive a browser connection; Claude's worker ends when its
official SDK disconnects. **End runtime** explicitly closes the owned provider
runtime. Saved snapshots remain available in this page after ending. A refresh
does not automatically reattach or replay a prompt. Endpoint loss leaves an
unknown outcome visible. These boundaries follow RC-01/03/05/07/08; RC-09/10/11
govern native history/usage meaning and authentication evidence.

## Run and data

Use the root Python environment and the separate `experiments/` pnpm installation.
Start the shared preview from `experiments/`:

```sh
PORT=56044 node spikes/055-orchestrator-mock-lab/serve.mjs
```

State defaults to ignored `experiments/artifacts/067-live-session-workspace/`.
`PDUM_LIVE_LAB_DIR` chooses another isolated root; `PDUM_CODEX_AUTH_SOURCE` selects
an explicit file-backed Codex credential source; `PDUM_CLAUDE_TOKEN_FILE` selects
an explicit setup-token file. Credentials stay on the host. The browser receives
session endpoints and native messages, not the credential contents.

The backend records the selected run identity, native history snapshots and
client-observed protocol messages in its ignored `runs/` tree. Live records carry
client receipt time; that is not substituted for native occurrence time. Codex
history is collected before stopping its app-server and later marked as a cached
snapshot. A session without a materialized history may report that absence.

## Qualification scope

Paid checks are coordinated by the main agent, using one small tool-producing
prompt per provider, explicit Luna/Haiku models, bounded time and retries, and
a usage ledger. Native Claude turn/budget limits are supplied only for the
qualification request; normal operator sessions do not inherit those probe limits.
No new production SDK or framework package is extracted in this phase.

## Closing extensions

[064](../064-history-continuation/README.md) qualifies resume/fork in the source
profile and recorded working directory. Earlier native context precedes new live
output; native measurement counters are not added to a second copy of historical
usage. Catalogue inspection and draft editing submit no prompt. Cross-provider
selection guards prevent continuing a stale inspected target.

[065](../065-session-lifecycle/README.md) separates client disconnect, interruption,
runtime end and owner loss. The Runtimes drawer shows owner-record state alongside
current native process/worker observations. Previous owner records are unowned;
the UI cannot stop them by treating stale metadata as a process handle. End-all
reports the actual targeted IDs and leaves other owners alone. A missing history
snapshot after an empty launch does not turn successful cleanup into a failed stop.

The active Codex test's turn interrupted while its shell process remained alive;
explicit runtime end was followed by verified cleanup. The selected Claude tool
stopped on interruption and emitted an error-shaped result followed by a matching
cancelled prompt UUID. The UI correlates an explicit interrupt with that native
event, while keeping the raw error. It does not label arbitrary errors cancellation.
These are selected measured cases, not universal tool-cancellation guarantees.

The [findings](../../docs/spikes/067-live-session-workspace.md) record measured
live/history differences and limits. Eight real no-model backend checks and six
pure interpretation regressions passed. One real browser tool-producing turn per
provider passed, followed by native history reads, exact selected conversation/
tool-content comparison and explicit runtime cleanup. Codex yielded three shared
native items, Claude four shared content blocks. Extra live protocol records and
missing historical usage/cost fields remain explicit. Total estimate:
**USD 0.00292343**, detailed in the [usage ledger](usage-ledger.md).

The [backend notes](backend-notes.md) and [projection notes](projection-notes.md)
hold implementation details for later architecture work. The UI was reviewed at
1440×900 and 390×844. Captured-stream replay qualified UI repairs without more
provider calls; a bounded 8 ms `HOT_SCOPE_TIME` diagnostic during accelerated
replay remains a recorded limit. The later 065 extension qualified the two selected
active-turn interruption cases separately. Do not infer broader failure,
subagent, attachment or recovery support from these selected examples.

Useful checks from the repository root / research workspace respectively:

```sh
.venv/bin/python experiments/spikes/067-live-session-workspace/backend_check.py
# From experiments/:
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run ../067-live-session-workspace/src/model/projections.test.ts
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab build
```
