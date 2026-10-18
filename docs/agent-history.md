# Agent history: sync, check, question, show

Two small tools turn local agent session history into one DuckDB database and read
it back, so an agent or a person can answer questions about agentic usage with ad
hoc SQL. The Python distribution `habemus-papadum-agent-history`
(`pdum.agent_history`, command `pdum-history`) owns the schema and the readers: it
ingests Codex homes and Claude Code configuration directories read-only and
publishes into a local DuckDB file or a MotherDuck database, incrementally. The
TypeScript package `@habemus-papadum/agent-history` (command `agent-history`) owns
everything that only needs a DuckDB connection: invariant checks, the analysis
question set, a session list and a terminal renderer for one session, against
either kind of target. The [roadmap](plans/agent-analysis-roadmap.md) records what
was deliberately left for later.

```sh
uv run pdum-history sync --example > "$(uv run python -c 'from pdum.agent_history.config import default_config_path as p; print(p())')"
uv run pdum-history sync                      # every source on this machine into every target
uv run pdum-history sync --target local       # one target
uv run --env-file .env pdum-history sync --target cloud --full   # MotherDuck, re-reading everything
uv run pdum-history ingest claude --db ~/history/claude.duckdb   # one source, one fresh file
cd typescript && pnpm -C packages/agent-history cli check ~/history/agents.duckdb
cd typescript && pnpm -C packages/agent-history cli sessions ~/history/agents.duckdb --limit 10
cd typescript && pnpm -C packages/agent-history cli show ~/history/agents.duckdb 89620c57 --blobs
cd typescript && pnpm -C packages/agent-history cli sessions ~/history/agents.duckdb --lineage 89620c57
cd typescript && pnpm -C packages/agent-history cli questions ~/history/agents.duckdb --tz America/New_York --show
cd typescript && MOTHERDUCK_TOKEN=... pnpm -C packages/agent-history cli check md:agent_history
```

After `pnpm -r build`, `node packages/agent-history/dist/cli.js` runs the same
commands without `tsx`.

## Answering a question with the toolkit

This is the runbook for an agent, or a person, asked something about agentic usage.

1. Refresh: `uv run --env-file .env pdum-history sync` (or `--target local` when
   MotherDuck is not needed). It only reads files that changed, so running it
   first is cheap and makes "as of now" true.
2. Trust the data before quoting it: `agent-history check <db>` must end with
   `0 failing`. A failing `zero` check is a planning item, not something to work
   around in a query.
3. Start from the standard set: `agent-history questions <db> --show` answers the
   recurring questions (cost by month, cache behaviour, tool failures, lineages,
   duty cycle) with the price snapshot's date stamped on every priced figure.
4. Go ad hoc with `agent-history sql <db> "..."`. The tables are in `pdum-history
   schema`; the grain is thread, turn, response, item, with `usage_events` as the
   deduplicated usage view and `lineage_id` as the unit a person calls a session.
   Prefer `items.text` to `item_blobs` for text search on MotherDuck.
5. Look at individual sessions with `sessions`, `sessions --lineage`, `show` and
   `show --blobs`, and leave notes with `tag` so the next reader finds them.
6. Say what the numbers cannot: list prices are a proxy for spend, Codex usage
   before September 2026 comes from counter deltas, Codex command durations are
   process-start times, and Claude's own cost ledger includes requests the
   transcript never shows. The section "What the data can and cannot say" has the
   full list.

## Sync: one command for the machine

`pdum-history sync` reads one YAML file that says what this machine ingests and
where it publishes, and does every pair in one run. Sources are Codex homes, Claude
configuration directories, or every profile of a launcher (`profiles: all` lists
the launcher's profile directory; a Codex profile is a Codex home, a Claude profile
keeps its native configuration under `claude/`). Targets are local DuckDB files and
MotherDuck databases (`md:<database>`, token from `MOTHERDUCK_TOKEN` or the
variable `token_env` names, so `uv run --env-file .env` is enough). The file lives
at the platform user configuration directory under `pdum-agent-history/history.yaml`,
or wherever `--config` or `PDUM_AGENT_HISTORY_CONFIG` points; `sync --example`
prints a starting point.

```yaml
window_days: 183
sources:
  - agent: codex
    home: ~/.codex
  - agent: codex
    profiles: all
  - agent: claude
    dir: ~/.claude
  - agent: claude
    profiles: all
targets:
  - name: local
    duckdb: ~/history/agents.duckdb
  - name: cloud
    motherduck: agent_history
    token_env: MOTHERDUCK_BROWSER_TOKEN
```

A run is incremental. The unit of work is one transcript file: a Claude session or
sub-agent file, a Codex rollout with its catalogue row. The target's `ingest_ledger`
remembers each unit's size, modification time and fingerprint (the catalogue's
`updated_at` and archived flag for Codex) per source, so unchanged files are
skipped, and new or grown files are parsed into a staging database and published by
replacing exactly that thread's rows inside one transaction. Codex logs are
appended from the target's newest log timestamp. A file that has vanished from the
agent's store is marked `gone` in the ledger and its rows stay: the agents' own
stores forget, this one does not, and removing history is never a side effect of a
run. After each source is published, fork edges and lineage are recomputed from the
store for that source (see Lineage below), which takes milliseconds because it reads
only `thread_links` and `threads`.

`--full` re-reads every present file and is the way to rebuild after a schema
change: a target holding another schema version is refused otherwise, and with
`--full` its tables are dropped and recreated (a `tagsdb` schema holding
annotations is left alone). `pdum-history ingest codex|claude --db <file>` still
builds one fresh file from one source; with `--sync` it is incremental too, and
with an `md:` target it always is.

Several machines publish into the same target. Every row carries the `source_id`
of the agent, machine and directory it came from, each machine writes only its own
rows and ledger entries, and `provenance` has one row per source, so a MotherDuck
database fed by a laptop and a desktop needs no coordination beyond both running
`sync`.

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
| `subagent-fork` | `fork-context-ref` | A sub-agent that inherits its session's context by reference; `inherited_records` is the referenced length and `fork_point_ts` the parent message it starts after. |
| `fork` | `rollout` | A Codex thread whose `session_meta` names `forked_from_id`. |

A continued session answers the prompt it inherited with responses of its own, so an
inherited turn says nothing about its responses: a message is a copy only when its
marker says so, or when it sits before the file's first own-marked message. Files
without any marker are taken at face value and counted by the
`claude-threads-without-markers` check; here those are Agent SDK sessions
(`sdk-ts`, `sdk-cli`), which write no markers and copy nothing. One case needs the
store: parallel sub-agents launched by one call can begin with the same responses
after their own prompt, and their files cannot say so. After each publish the
earliest-started thread of a source keeps such a response and the other copies are
marked, so usage counts it once and the duplicate check stays at zero. Copied responses and items carry
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
decreases, continued lineages, edges with a missing endpoint, Claude files without
markers, Claude cost snapshots that disagree with the transcript. A failing check is a
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
  (see Lineage above), and ownership never needs another file, which is what
  makes one file the unit of incremental work. Sub-agents reuse their parent's
  prompt id for their own first turn, so turn ids are never used for ownership. A `continued-in` record
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
| Both, plus a launcher profile, in one `sync` to one file | 766 | 35 s | 1.3 GB |
| The same `sync` again with nothing changed | 0 | 0.5 s | |
| The same three sources, `sync --full` into MotherDuck | 766 | 103 s | 0.44 GB reported |
| The same `sync` into MotherDuck with three files changed | 3 | 13 s | |
| `agent-history check` against MotherDuck | | 2.7 s | |

Blobs are most of the file. Every question in the set answers in milliseconds
except full-text search over blobs, which takes under a second locally and
nine to twelve seconds on a Standard MotherDuck instance; every other statement
there costs 25 to 80 ms of round trip, so a `sync` into MotherDuck spends about a
minute uploading blobs and a few seconds on everything else. Spike 036 in the
experiments workspace holds the measurements.
