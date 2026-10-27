# 068 — Claude process ownership and full output replay

**Working disposable spike, 25 October 2026.** Can a small service own one native
Claude process independently of its clients, forward their JSONL writes unchanged,
and give every attached client the same native output, including a complete replay?

**Yes for the selected cases on Claude Code 2.1.310.** No conversation SDK is
imported by this server or either client. The native process acknowledges user
messages, reports command lifecycle, reflects accepted permission responses and
answers control requests. Two clients can therefore share the stream without
server-side conversation validation or arbitration. Read the
[findings](../../docs/spikes/068-claude-feed-replay.md) first, then
[protocol observations](protocol-notes.md), [browser qualification](browser-qualification.md)
and the [usage ledger](usage-ledger.md).

This changes the proposed Claude ownership direction. It does **not** change the
production launcher or 067: those still have the previously implemented official
SDK/disconnect behavior. Existing user work and the shared lab server are untouched.

## Scope and decisions

| Question | Treatment in this spike |
| --- | --- |
| Should closing the final browser stop the process? | User answered no. An explicit stop owns that action. |
| Should the service interpret/approve input or synthesize acknowledgements? | User answered no. It forwards exact transport bytes to stdin. |
| What is replayed to clients? | All native stdout, with replay/live transport markers. Both stdin and stdout are journaled, but stdin is not an acknowledgement feed. Stderr stays diagnostic. |
| Where is the journal? | Delegated provisional location: `<profile>/.aiui/running/<process-session-id>/feed.jsonl`. |
| How are duplicate/competing actions interpreted? | Client matches native IDs, echoed decisions and lifecycle; native Claude determines execution. |
| What survives owner death, and when do we reclaim old journals? | Deferred production policy. Current owner supplies replay from memory, persists a diagnostic journal, and supports explicit reap after process exit. No pipe recovery/adoption. |
| Snapshotting, pruning, image removal, remote auth? | Deferred until needed; full payloads retained here. |

Applicable contracts: **RC-07** (unknown delivery, asynchronous observation and
owner loss), **RC-08** (the explicitly revised Claude lifetime), **RC-09** (native
history versus runtime feed), **RC-12** (new runtime from native history is separate
from attaching to an existing one). Acceptance tests below connect each boundary
with an actual operation. Components affected: client foundation, session workspace,
observation, native history and host coordinator.
The resulting versioned findings are retained in
[RC-13](../../../docs/runtime-contracts.md#rc-13-claude-feed-replay-can-use-native-multi-client-outcomes).

## Run

Commands below run from `experiments/`. This spike deliberately uses the repository
root `.venv`, which already supplies aiohttp and psutil; it adds no dependency or
lockfile. It does not import any production launcher or Claude SDK runtime.

```sh
# Synthetic byte-producer transport tests; no model and no credentials.
../.venv/bin/python -m unittest discover -s spikes/068-claude-feed-replay -p test_transport.py -v

# Actual native controls, invalid token, zero model inputs.
../.venv/bin/python spikes/068-claude-feed-replay/no_model.py
../.venv/bin/python spikes/068-claude-feed-replay/malformed.py

# Explicit paid checks, using the operator's supplied ignored 066 token file.
../.venv/bin/python spikes/068-claude-feed-replay/live.py
../.venv/bin/python spikes/068-claude-feed-replay/permission.py

# Re-derive historical recorded costs; no provider calls.
../.venv/bin/python spikes/068-claude-feed-replay/collect_costs.py
```

The combined live harness submits at most four user inputs, with two native
USD 0.05 budgets, three model turns per input, a 256-token output bound, and a
160-second deadline. The permission-only follow-up submits one input with a
USD 0.03 budget and 80-second deadline. Both use Haiku only. These are experiment
bounds, not proposed application quotas. The two original failed harness runs
are retained in the ledger; the final permission run used the corrected native
response behavior. No model retries occur automatically.

To inspect the independent service manually:

```sh
../.venv/bin/python spikes/068-claude-feed-replay/server.py \
  --root artifacts/068-claude-feed-replay/manual --host 127.0.0.1 --port 0
```

Without `--token-file`, the service deliberately supplies an invalid no-model
token. To use the existing qualified credential, explicitly add
`--token-file artifacts/066-claude-setup-token/setup-token.txt`. Credential values
are read only into child environment, never returned by management APIs. The
standalone server binds all interfaces by default; local tests choose loopback.
Each launch creates an isolated home, profile and working directory.

| Operation | Surface | Meaning |
| --- | --- | --- |
| Launch | `POST /sessions` with `{}` or experiment options | Starts process now; no client attachment or model prompt. |
| List/status | `GET /sessions`, `GET /sessions/{id}` | Owned processes, native PID/exit, client count and journal/client backlogs. |
| Attach | WebSocket `/sessions/{id}/feed` | Full stdout replay, then ongoing stdout. |
| Write | Text/binary WebSocket message | Exact bytes to stdin. The client supplies complete JSONL plus newline. |
| Disconnect | Close socket | Removes only this subscriber. |
| Stop | `POST /sessions/{id}/stop` | Terminates this owned native process. |
| Reap | `POST /sessions/{id}/reap` | After exit, removes the runtime journal and in-memory replay. Leaves native history. |

The browser check uses the actual WebSocket API in two Chrome contexts; see its
[reproduction instructions](browser-qualification.md). No polished mock page is
needed to establish this transport boundary.

## Implementation map

- `server.py`: process ownership, byte journal, per-client delivery queues, explicit
  replay boundary, management routes. It never parses Claude protocol frames.
- `client.py`: native JSONL parsing, UUID generation and control matching for probes.
- `no_model.py`, `malformed.py`: real native protocol/cleanup checks without inference.
- `live.py`, `permission.py`: bounded real model, concurrency and callback evidence.
- `test_transport.py`: real subprocess/network byte and ordering checks with a
  deliberately synthetic producer; not evidence of model compatibility.
- `browser-check.js`: actual browser transport probe, with no model-prompt action.
- `collect_costs.py`: reproducible estimate from ignored records and the existing
  17 October price snapshot.

Server transport ordering is small but consequential: attachment snapshots the
journal and registers the subscriber without an intervening await; later output
queues behind `replay-end`. Disk writing and socket delivery are separate tasks.
The service shows backlog/errors rather than imposing queue or payload limits.
A journal sequence covers all pipe directions, so gaps in stdout-only sequence
numbers are normal; they do not establish lost output. Disk is not fsynced per
record and process-crash durability is not promised.

## Evidence

All local raw evidence remains under ignored `artifacts/068-claude-feed-replay/`:

- `20261025T164140-no-model-84356/report.json`: nine native no-inference checks.
  This first name uses local time; subsequent paid names use UTC explicitly.
- `20261025T204216Z-live-84960/report.json`: four successful model results; five
  lifecycle/concurrency checks passed; callback expectation timed out because
  native manual mode auto-allowed harmless `printf`.
- `20261025T204320Z-permission-88574/report.json`: forced callback and pending
  snapshot succeeded; harness wrongly waited for cancellation instead of the
  actual reflected accepted response, then timed out after successful result.
- `20261025T204408Z-permission-89526/report.json`: corrected callback follow-up,
  six checks passed, including a late opposing answer and replayed resolved state.
- `20261025T204416Z-malformed-89684/report.json`: malformed JSON ends the native
  process with exit 1 and stderr, without a correlated stdout rejection.
- `root-browser-smoke/report.json`: two actual Chrome contexts; no inference.
- `costs.json`: six submitted inputs and six successful native results; total
  API-equivalent estimate **USD 0.00283440**. Both harness failures are included.

Four synthetic byte-transport checks passed: invalid/non-UTF8 bytes untouched;
ten clients joining during byte-fragmented UTF-8/JSONL output; stalled disk writing
while forwarding continues; and a 2 MiB final output before process-exit, including
late attachment. These checks qualify ordering, not native protocol semantics.

All experiment-owned native processes were stopped, including both harness-timeout
cases. Token source content remained unchanged. No ordinary developer profile,
config or session was written. No production APIs or package versions changed.
