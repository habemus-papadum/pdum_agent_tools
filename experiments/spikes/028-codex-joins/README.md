# 028 — Join and control research

The [result](../../docs/spikes/028-codex-joins.md) answers the architecture question:
support multiple listeners/responders; reconcile native state and retain gaps.
These runners are research code, not a proposed production SDK.

Run from `experiments/`, with the parent workspace already installed:

```sh
uv run --no-project /ABS/ROOT/.venv/bin/python spikes/028-codex-joins/probe.py
uv run --no-project /ABS/ROOT/.venv/bin/python spikes/028-codex-joins/stream_and_control.py
uv run --no-project /ABS/ROOT/.venv/bin/python spikes/028-codex-joins/direct.py
```

The explicit root interpreter supplies the existing `pdum.codex_launcher`
integration. No experiment dependency is installed in production packages.
Ordinary runs use production `launch` and `JsonlRecorder`; direct control uses
that owner's backend Unix WebSocket and leaves the unused relay open. The
separate [032 runner](../032-codex-health/README.md) extends the same evidence with
pending MCP, cancellation, and no-client progress. No browser automation is
claimed by these Python WebSocket checks.

Private runs, all 14 October 2026:

| Artifact under `artifacts/` | Work | Reported API-equivalent USD |
| --- | --- | ---: |
| `028-codex-joins/1792000357102` | Three dynamic-tool turns, before/pending/after joins, B response, race, unsubscribe, all-disconnect, restart | 0.00229862 |
| `028-codex-joins/1792000437132` | Streaming, human question/race, concurrent same-ID submissions and completed-turn repeat | 0.00206748 |
| `028-codex-joins/1792000690320` | One native Unix-WebSocket turn, B resume/replay/response, no relay traffic | 0.00227814 |
| `032-codex-health/1792000622357` | Pending MCP, cancelled dynamic callback, work with no clients | 0.00196074 |

The three 028 runs total $0.00664424 of reported API-equivalent usage. The shared
032 row is counted by 032, not again by 028. All runs retain `level0.json`,
`clients.jsonl`, `relay.jsonl` (empty when bypassed), native profile/session files,
launcher process diagnostics, snapshots, attempts and a result ledger. Raw relay
records may contain authentication and are private ignored artifacts. Client
records omit the login credentials. Source auth is hashed before/after; no normal
sessions/config are imported. Profile directories remain private so histories
can be inspected without another model call.

Each runner has a wall limit (480 seconds; direct 120), up to ten explicitly
submitted turns, 32 observed tool items, no retry loop or model fallback, and a
$0.20 observed-usage ceiling. These are experiment bounds, not runtime defaults
or provider-enforced budgets. The streaming follow-up deliberately issues three
duplicate/competing submissions; that is a test, not a retry policy. Cancellation
can leave a completed model response without a usage update, so the ceiling and
reported amounts do not cover all possible usage.

The offline verifier requires the recorded runs and makes no network calls:

```sh
uv run --frozen python spikes/028-codex-joins/verify.py \
  artifacts/028-codex-joins/1792000357102 \
  artifacts/028-codex-joins/1792000437132 \
  artifacts/028-codex-joins/1792000690320 \
  artifacts/032-codex-health/1792000511740 \
  artifacts/032-codex-health/1792000622357
uv run --frozen ruff check spikes/028-codex-joins spikes/032-codex-health
uv run --frozen ruff format --check spikes/028-codex-joins spikes/032-codex-health
```

All passed on the five recorded runs. The verifier checks actual native evidence,
including the denied-command rollout and child history. It is an artifact check,
not a synthetic provider-success test or a claim that excluded cases passed.

Price date 14 October 2026: [Luna Standard](https://developers.openai.com/api/docs/models/gpt-6-luna)
per million tokens $0.10 input, $0.01 cached input, $0.125 cache writes, $0.50 output.
Input includes cached/write tokens; output includes reasoning. Latest cumulative
per-thread counters are counted once across clients, not summed as snapshots.
Cache writes were zero in these runs. Estimates assume the requested Luna/default
tier; they are not subscription billing. No upstream capture was made here, so
warmup and unreported interrupted work remain unknown. Compaction/fork accounting
is handled by 029/033, not this tiny estimate helper.

Source findings are anchored to `6c372fbef45f730b6d8aa727b0ec8332365588db`:

- [Resume](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L720)
  merges active state, registers the subscriber, sends the response, usage/goal
  snapshots and pending requests inside the listener command handler.
- [Pending requests](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/outgoing_message.rs#L452)
  replay in request-ID order. First response removes the callback; losers log a
  warning, not an RPC result. Verification ownership is explicitly special.
- [Human request](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/bespoke_event_handling.rs#L829)
  and [dynamic request](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/bespoke_event_handling.rs#L1089)
  use different completion paths, explaining the observed resolved-notification
  difference. Callback IDs must not be confused with client request IDs.
- [Start or steer](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/turn_processor.rs#L664)
  explains why competing starts can share one turn while both inputs are kept.
- [Idle unload predicate](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L59)
  requires both no subscribers and no active status, followed by the configured
  delay. We tested active lifetime, not the default idle-unload interval.

A practical client state model is `disconnected/unknown → initialized →
resuming → observing`, with pending callbacks as a set and completeness tracked
per item. Disconnect invalidates freshness; it does not prove work stopped.
Unsubscribe removes one subscription; do not equate it with interruption.
On response races, close the UI prompt when native resolution/item state says it
ended; do not promise that an unacknowledged local answer won. Rejoining completed
history is safe evidence recovery, but blindly repeating a turn submission can
create more user input and more model work.
