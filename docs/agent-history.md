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
cd typescript && pnpm -C packages/agent-history cli questions ~/history/codex.duckdb --tz America/New_York --show
```

After `pnpm -r build`, `node packages/agent-history/dist/cli.js` runs the same
commands without `tsx`.

## What the ingesters read and write

| Source | Inputs | Facts | Blobs |
| --- | --- | --- | --- |
| Codex home | `state_5.sqlite` catalogue, `thread_history_1.sqlite` projection, `logs_2.sqlite`, every rollout JSONL under `sessions/` and `archived_sessions/` | threads, turns with model and effort from `turn_context`, one response per `token_usage_record`, `token_count` events with rate limits and credits, items, events, raw response items, logs | full item JSON in `item_blobs` |
| Claude Code directory | `projects/<cwd>/<session>.jsonl` and every file under `<session>/subagents/`, including workflow agents | threads per session and per sub-agent, turns derived from prompts, one response per API message id, items from content blocks paired with their tool results, events for compaction, cost snapshots, API requests and workflow records | tool calls with their results and message blocks in `item_blobs` |

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

## Policy: window, drift, invariants

The ingesters model the last 183 days by default (`--window-days`, 0 for all).
Older threads appear in `coverage` with `in_window = false` and are otherwise
skipped; older storage formats are counted, not adapted. `agent-history check`
prints invariants. Those marked `zero` must be zero: schema version, unknown
line types inside the window, duplicate response ids, orphan rows. Those marked
`info` are numbers worth a glance: copied context, open tool items, counter
decreases, Claude cost snapshots that disagree with the transcript. A failing
check is a planning item for a separate session, not something to patch inline.

## What the data can and cannot say

- Codex records usage per model response only since September 2026; older
  threads expose cumulative counters, and the delta fallback reproduces the
  per-response totals within about two percent in aggregate.
- Codex command items from unified exec complete at process startup, so their
  item duration is zero for most commands. Tool wall time comes from the raw
  call and output pairs in `response_items`.
- Claude Code files copy earlier context verbatim when a session continues or a
  sub-agent forks, ids included. The earliest-started thread owns an id; later
  copies are marked and excluded from usage, and sub-agents reuse their parent's
  prompt id for their own first turn, so turn ids are never used for ownership.
- Claude's own `cost-state` snapshots carry no timestamp and include side
  requests such as title generation and retries, so they do not reproduce from
  the transcript within two percent for most sessions. The check reports the
  count and leaves the explanation to a later investigation.
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
| Codex home, 221 rollouts, 791 MB | 221 | 9 s | 396 MB |
| Claude directory, 119 sessions and 430 sub-agent files, 1.3 GB | 549 | 21 s | 894 MB |

Blobs are most of the file. Every question in the set answers in milliseconds
except full-text search over blobs, which takes under a second.
