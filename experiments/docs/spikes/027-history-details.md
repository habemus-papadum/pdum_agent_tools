# 027 completeness and reconstruction details

## Evidence sources

The two live turns each executed one real command, printed distinct stdout/stderr
markers, created `evidence.txt` with apply_patch and replied `HISTORY_DONE`.
`level1.jsonl` is recorded client-protocol traffic, with local sequence, connection,
wall time and monotonic receipt time. It is not upstream model traffic and its
sequence is not a server replay cursor. `corpus.json` holds loaded, unsubscribed
and post-restart RPC snapshots. Native `*-native-rollout.jsonl` copies are diagnostic
storage evidence owned by this experiment. They are not stable public client APIs.

The original corpus and snapshots remain immutable while 026/029 reuse its profile.
Later live state need not equal those original snapshots. `analyze.mjs` reads only
those saved files; deliberately omitting the live recording leaves a history-only
transcript with the losses below. It cannot recover the omitted stream by inference.

## Field-by-field comparison

| Field/family | Recorded live protocol | Paginated cold history | Legacy cold history |
| --- | --- | --- | --- |
| User input text | Completed user item and request | Exact text and live item ID | Exact text, synthesized item ID |
| Assistant final text | Deltas plus completed item | Final text, phase and live item ID | Final text/phase, synthesized item ID |
| Visible reasoning | None emitted in this corpus | Not qualified | Not qualified |
| Shell invocation | commandExecution command/cwd/source | Preserved | Command item omitted in tested custom `exec` wrapper case |
| Tool result | Combined command output, exit 0, duration | Preserved for short command | Omitted with command item |
| stdout versus stderr | Combined output in observed command item | Combined; cannot split the streams retrospectively | No command item |
| File change | apply_patch item with path/kind/diff | Preserved, stable ID | Preserved, stable patch ID |
| Original tool-wrapper arguments | Not generally the same as visible command | Not a full upstream request | Present in private native custom_tool_call, not rendered by structured history |
| Turn timing | Local receipt times and native turn times | startedAt/completedAt seconds, durationMs | Same turn timing fields observed |
| Item timing | Native emittedAt/receipt times where present | items/list includes startedAtMs/completedAtMs | items/list unavailable |
| Per-delta ordering/timing | Available if captured | Not recreated | Not recreated |
| Model/provider | Requested config, start/resume and observations | Latest thread metadata, not per-completion effective attribution | Same limitation |
| Input/cache/output/reasoning counters | Six thread/tokenUsage notifications | Not in returned turns/items | Not in returned turns/items |
| Context window | modelContextWindow 258400 in usage | Absent from these history views | Absent |
| Errors/approval decisions/questions | No such cases in primary corpus | Not qualified by this run | Not qualified by this run |
| Images/children/dynamic callbacks | Use 028/031/032 separate corpora | Not implied by this text/tool corpus | Not implied |
| Compaction | 029 records explicit lifecycle | 029 history retains contextCompaction marker | Not tested here |

All four paginated completed items exactly matched live IDs. Legacy user/final IDs
changed to positional `item-1`/`item-2`, so joining by ID across its live and historical
views fails. Matching by text alone is unsafe with repeated messages. Turn identity
was preserved in both modes.

The native legacy rollout did retain `custom_tool_call`/`custom_tool_call_output`
records with the code-mode exec wrapper and result. Therefore the missing command
is a structured-history projection loss in this observed path, not proof every
trace of the command was deleted from all native storage. That distinction matters
for optional versioned diagnostic importers.

## Pagination, activity and loss

`thread/turns/list` defaults to descending summary. Summary deliberately contains
the user/final items and omits command/file items; a local shell-only turn has empty
summary items despite completed work. `itemsView:"full"` is necessary for tools.
Paginated items default ascending. Forward pages, reverse direction using returned
`backwardsCursor`, and exclusive `{type:"item",itemId}` anchors were exercised.
The item anchor without a nonempty turn ID fails `-32602`. Opaque cursors were
stored/passed back without depending on their JSON implementation.

During `sleep 1`, live `item/started` had arrived but items/list was empty and the
current full turn had `status:"inProgress"`, empty items. On completion the durable
item became visible with combined output and timestamps. No snapshot-plus-stream
gap-free guarantee follows from history alone. Tail polling must revisit the current
turn rather than treating an empty page as terminal completion.

The local 70,000-byte test preserved all 70,000 in live completed output and stored
65,536 including a truncation marker. A recorder that saves native history only
cannot later reconstruct the missing center. This does not justify adding a cap
to the application's inspection path.

History-only reads after a clean restart were run without logging in; loaded lists
remained empty and no turn/tool/usage notification appeared. Storage migration or
index maintenance was not instrumented and is not claimed absent. An archive test
also unloaded the fork and retained readable history. Unsubscribe returned success
but the loaded list still contained the thread at the immediate observation point.

## Source explanation and newer item lookup

At clean pin `6c372fb...`, [rollout persistence policy](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/rollout/src/policy.rs#L125)
labels execution end, approval requests and streaming deltas transient; paginated
history persists completed typed items instead. [Completed-item persistence](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/rollout/src/policy.rs#L228)
keeps only selected item variants in legacy mode and caps persisted command output
at 64 KiB in paginated mode. The [legacy builder](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors.rs#L730)
filters records through that policy before projecting API turns. These source
observations explain the run but are not assertions that every older release
shares the same code or every item family has been tested.

026 tested the new source-build `thread/items/read`: known paginated IDs resolve,
unknown IDs are omitted from a mixed result, empty input fails, legacy is unsupported.
This is a useful efficient detail fetch, not an event replay endpoint.

## Usage ledger

2026-10-14 Luna Standard rates used for the estimate: input $0.10/M, cached input
$0.01/M, output $0.50/M ([official model page](https://developers.openai.com/api/docs/models/gpt-6-luna)).
Paginated final total: input 30,911, cached 28,928, output 94. Legacy final total:
input 30,934, cached 22,784, output 106. Cache write and reasoning output were zero.
Inclusive input minus cached input is priced at the input rate; successive cumulative
snapshots are not summed. Combined observed estimate: $0.00163042. No upstream MITM
capture was made here, so unreported warmups, interrupted response usage and other
provider accounting are not proven zero. Actual subscription billing is unknown.
