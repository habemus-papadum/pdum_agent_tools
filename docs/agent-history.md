# Agent history: ingest, check, question, show

Two small tools turn local agent session history into one DuckDB file and read it
back. The Python distribution `habemus-papadum-agent-history` (`pdum.agent_history`,
command `pdum-history`) owns the schema and the readers: it ingests a Codex home or
a Claude Code configuration directory read-only. The TypeScript package
`@habemus-papadum/agent-history` (command `agent-history`) owns everything that
only needs a DuckDB connection: invariant checks, the analysis question set, a
session list and a terminal renderer for one session. The same SQL can later run
in a browser through DuckDB-WASM or against MotherDuck; the
[roadmap](plans/agent-analysis-roadmap.md) records that staging.

```sh
uv run pdum-history ingest codex --db ~/history/codex.duckdb
uv run pdum-history ingest claude --db ~/history/claude.duckdb
cd typescript && pnpm -C packages/agent-history cli check ~/history/codex.duckdb
cd typescript && pnpm -C packages/agent-history cli sessions ~/history/claude.duckdb --limit 10
cd typescript && pnpm -C packages/agent-history cli show ~/history/claude.duckdb 89620c57 --blobs
cd typescript && pnpm -C packages/agent-history cli sessions ~/history/claude.duckdb --lineage 89620c57
cd typescript && pnpm -C packages/agent-history cli questions ~/history/codex.duckdb --tz America/New_York --show
```

After `pnpm -r build`, `node packages/agent-history/dist/cli.js` runs the same
commands without `tsx`.

## What the ingesters read and write

| Source | Inputs | Facts | Blobs |
| --- | --- | --- | --- |
| Codex home | `state_5.sqlite` catalogue, `thread_history_1.sqlite` projection, `logs_2.sqlite`, every rollout JSONL under `sessions/` and `archived_sessions/` | threads, turns with model and effort from `turn_context`, one response per `token_usage_record`, `token_count` events with rate limits and credits, items, events, raw response items, logs, fork edges from the rollout's first line | full item JSON in `item_blobs` |
| Claude Code directory | `projects/<cwd>/<session>.jsonl` and every file under `<session>/subagents/`, including workflow agents | threads per session and per sub-agent, turns derived from prompts, one response per API message id, items from content blocks paired with their tool results, events for compaction, cost snapshots, API requests and workflow records, fork edges from `session_id` markers, `continued-in` records and `fork-context-ref` | tool calls with their results and message blocks in `item_blobs` |

Both write the tables of one schema. Every row carries `source` and `origin`;
the `usage_events` view returns per-response usage where it was recorded and
positive counter deltas otherwise, and leaves out lines a file copied from
another session or a parent (`origin = 'copied-context'`). The contract is
exported by `pdum-history schema --json`; the TypeScript package keeps a copy in
`typescript/packages/agent-history/schema/agent-history.schema.json`, a Python
test compares the two, and CI diffs them. Bump `SCHEMA_VERSION` when a table,
column or view changes and regenerate the copy.

## Provenance and tags

Every fact row carries a `source_id`, and a `provenance` row describes each
source once: a `host_id` minted on first use and kept under the launcher's own
data directory (`pdum-agent-history/host.json`, overridable with
`PDUM_AGENT_HISTORY_HOST_ID`), the hostname as a label that may change, the
operating-system user, the agent kind, the root directory read, the agent
versions seen, the window cutoff and the schema and ingester versions. Thread,
turn, response and item ids are already unique across machines, so files from
several machines merge by union with `source_id` as the discriminator. Codex
threads also carry a normalized `repo` from their git origin; Claude transcripts
record no origin, so their `repo` is null and the working directory stands in.

Tags live in a separate file beside the history file, `codex.tags.duckdb` for
`codex.duckdb`, with one `tags` table keyed by subject kind and stable id. They
are written by `agent-history tag`, never by an ingester, so they survive a
rebuild of the history file and a later move to MotherDuck:

```sh
agent-history tag ~/history/codex.duckdb thread 01a140ad project=pencil-lab reviewed
agent-history tags ~/history/codex.duckdb --kind thread
agent-history sessions ~/history/codex.duckdb --tag project=pencil-lab
agent-history show ~/history/codex.duckdb 01a140ad      # header lists the thread's tags
agent-history sql ~/history/codex.duckdb "select * from tagsdb.tags"
```

## Lineage: a session is not a file

Claude Code starts a new file whenever a session is continued after compaction or
forked, copies the inherited transcript into it with ids and timestamps intact, and
never writes a parent link. Codex names the fork parent in a rollout's first line.
Both ingesters write `fork_edges` and set three columns on `threads`: `forked_from_id`
(the direct predecessor), `lineage_id` (the root of the chain, a thread's own id on a
root) and `lineage_depth`. A sub-agent belongs to its session's lineage, so one
`lineage_id` is what a person means by "a session": every file it was continued into
and every agent it launched. `created_at` is the thread's first own message; the
inherited prefix dates the edge, not the thread.

| Edge `kind` | `evidence` | Meaning |
| --- | --- | --- |
| `continuation` | `marker`, `marker+continued-in`, `continued-in` | A Claude session continued or forked from the parent. Since Claude Code 2.1.199 every copied message keeps its producer's id in `session_id`, and the ingester checks that each marked uuid really exists in the named file, so the marker decides ownership and names the direct parent. From 2.1.220 the parent also writes a `continued-in` record, which confirms the edge or stands alone when the successor file is gone. |
| `continuation` | `uuid-overlap`, `ambiguous = true` | A file without markers that holds copies of another thread's messages; the earliest-started thread is taken as the parent. |
| `subagent-fork` | `fork-context-ref` | A sub-agent that inherits its session's context by reference; `inherited_records` is the referenced length and `fork_point_ts` the parent message it starts after. |
| `fork` | `rollout` | A Codex thread whose `session_meta` names `forked_from_id`. |

A continued session answers the prompt it inherited with responses of its own, so an
inherited turn says nothing about its responses: a message is a copy only when its
marker or uuid ownership says so. Copied responses and items carry
`origin = 'copied-context'` and their `session_id` names the producer, which is why a
lineage's usage is the plain sum over its threads without double counting.
`agent-history sessions --lineage <id>` lists one lineage with its sub-agents, `show`
prints `continues` and `continued in` lines, and question Q23 ranks lineages.

## Policy: window, drift, invariants

The ingesters model the last 183 days by default (`--window-days`, 0 for all).
Older threads appear in `coverage` with `in_window = false` and are otherwise
skipped; older storage formats are counted, not adapted. `agent-history check`
prints invariants. Those marked `zero` must be zero: schema version, unknown
line types inside the window, duplicate response ids, orphan rows, threads
without a lineage, fork edges whose child started before its parent. Those marked
`info` are numbers worth a glance: copied context, open tool items, counter
decreases, continued lineages, ambiguous edges, edges with a missing endpoint,
Claude cost snapshots that disagree with the transcript. A failing check is a
planning item for a separate session, not something to patch inline.

## What the data can and cannot say

- Codex records usage per model response only since September 2026; older
  threads expose cumulative counters, and the delta fallback reproduces the
  per-response totals within about two percent in aggregate.
- Codex command items from unified exec complete at process startup, so their
  item duration is zero for most commands. Tool wall time comes from the raw
  call and output pairs in `response_items`.
- A Codex home that only ran `codex exec` has rollouts but no materialized
  projection. Its items are then built from the rollout's `item_completed`
  events (`origin = 'rollout'`), after normalizing the core's item shape to the
  v2 shape; the summary notes say when that happened.
- Claude Code files copy earlier context verbatim when a session continues, ids
  included. The `session_id` marker on each message settles what a file owns
  (see Lineage above); files from before 2.1.199 fall back to the earliest-started
  thread owning an id. Sub-agents reuse their parent's prompt id for their own
  first turn, so turn ids are never used for ownership. A `continued-in` record
  is stamped when the successor starts, often days later, so it neither ends
  the thread nor extends its last turn.
- Claude's own `cost-state` ledger starts with the session process and is carried
  into the sessions that continue it, so the check compares a snapshot with the
  responses of its ancestor chain, each ancestor up to the branch point, between the
  ledger's start and the snapshot. Snapshots carry no timestamp, so the last
  response before one stands in. With no away summary and no compaction in
  the chain, most snapshots then agree; otherwise the ledger reads higher by
  roughly one context's worth of cache reads per away summary or compaction
  (correlation with the excess 0.82 and 0.64 here), because the summarisation
  requests behind them, like title generation and retries, are never written as
  responses. Some sessions also restart the ledger when resumed in a new
  process. The check stays an `info` count.
- Cost is a list-price proxy from a trimmed snapshot of the LiteLLM price table
  (`src/litellm-snapshot.json` in the TypeScript package), which carries the
  one-hour cache-write rate for Claude models and the long-context rate for the
  GPT-6 models. Every priced output is stamped with `litellm <fetch date>`;
  `agent-history prices refresh` rewrites the snapshot and `prices show <model>`
  prints the resolved rates. Claude usage is split into five-minute and one-hour
  cache writes (`cache_write_1h_input_tokens`), which matters: about a third of
  Claude cache-creation tokens here are one-hour tier, and flat pricing would
  understate spend by roughly nine percent. Models absent from the table are
  reported as an unpriced share, never imputed.
- Claude writes one record per content block with the usage repeated, and
  sub-agent files put placeholder output counts on earlier blocks, so the
  ingester keeps the member with the most output per message id. Discarded
  model-fallback attempts in the `iterations` ledger land in
  `wasted_output_tokens`.

## Sizes and times measured on 17 October 2026

| Input | Files | Ingest | DuckDB file |
| --- | ---: | ---: | ---: |
| Codex home, 221 rollouts, 791 MB | 221 | 10 s | 397 MB |
| Claude directory, 119 sessions and 430 sub-agent files, 1.3 GB | 549 | 22 s | 891 MB |

Blobs are most of the file. Every question in the set answers in milliseconds
except full-text search over blobs, which takes under a second.
