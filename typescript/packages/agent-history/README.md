# @habemus-papadum/agent-history

Checks, questions and forensics over the DuckDB files that the Python
`pdum-history` ingesters write from Codex homes and Claude Code directories.
The existing root/CLI uses the Node DuckDB adapter. The `/analysis` entry below
is already portable; broader query-driver/browser integration remains future work.
It never writes a history file.

## Portable pricing

Browser and Node clients can import shared pricing without loading filesystem,
CLI or native database code:

```ts
import {
  estimateResponseCost,
  summarizeResponseCosts,
} from "@habemus-papadum/agent-history/analysis";

const observation = {
  model: "gpt-6-luna",
  usage: { uncached: 1000, cached: 2000, cacheWrite: 0, cacheWrite1h: 0, output: 100 },
};
const estimate = estimateResponseCost(observation);
const summary = summarizeResponseCosts([observation]);
// Inspect estimate.status / summary.complete before displaying the known subtotal as complete.
```

`/analysis` exports the same snapshot, model resolution, rate lookup and cache
arithmetic as the existing pricing module, plus explicit per-record and aggregate
coverage. Missing usage, invalid counters and unknown/incomplete prices remain
distinct; their USD values are `null`, not zero. The `<synthetic>` sentinel is
explicitly excluded. Every estimate/summary records the table's date.

Callers must first normalize provider-specific counters into `Usage`: uncached
input, cache-read input, total cache-write input (including its one-hour subset),
and output. Do not add inclusive input to its cached portion again. The helpers
accept already-deduplicated observations; native response/source identity,
inherited fork exclusion and the completeness of captured traffic remain with
the adapter. `complete` describes only the supplied records and selected table,
not all provider work, context occupancy or an actual subscription bill. These
helpers do not infer service-tier or context-tier pricing from token totals.

Source-first development resolves `/analysis` to `src/analysis.ts`; built consumers
use `dist/analysis.js` and declarations through the matching publish map. A real
multi-entry build test traverses that entry's output graph and rejects Node/native
database dependencies. The Node root still exposes `refreshSnapshot` and the
existing CLI surface; snapshot refresh remains an explicit I/O operation.

This is the S0 pricing boundary, guided by RC-09/10/14 and spike 070. Full shared
health reducers, source-scoped query fixes, HP source registration and the known
out-of-turn compaction invariant remain later work; this extraction does not
claim those have been implemented.

## Node CLI and existing database tools

```sh
pnpm -C packages/agent-history cli check ~/history/codex.duckdb
pnpm -C packages/agent-history cli questions ~/history/codex.duckdb --tz America/New_York --show
pnpm -C packages/agent-history cli sessions ~/history/claude.duckdb --limit 10
pnpm -C packages/agent-history cli show ~/history/claude.duckdb 89620c57 --blobs
pnpm -C packages/agent-history cli sessions ~/history/claude.duckdb --lineage 89620c57
pnpm -C packages/agent-history cli sql ~/history/codex.duckdb "select count(*) from items"
pnpm -C packages/agent-history cli tag ~/history/codex.duckdb thread 01a140ad project=pencil-lab reviewed
pnpm -C packages/agent-history cli sessions ~/history/codex.duckdb --tag project=pencil-lab
pnpm -C packages/agent-history cli prices show claude-fable-5-1
MOTHERDUCK_TOKEN=... pnpm -C packages/agent-history cli sessions md:agent_history --limit 10
```

`check` prints invariants: `zero` checks must be zero, `info` checks are numbers
worth a glance, and the exit code is 1 when a zero check fails. `questions` runs
the analysis set with cold and warm latency. `sessions` and `show` are the
forensics view: recent threads with usage, a list-price estimate and their place in a
lineage, and one session rendered as turns and items with optional tool-output
excerpts from `item_blobs`; `sessions --lineage` lists every file and sub-agent of
one lineage.

The library exports `HistoryDb`, `runChecks`, `runQuestions`, `listSessions`,
`loadSession`, `renderSession` and the schema contract. The contract is a copy of
`pdum-history schema --json` in `schema/agent-history.schema.json`; a Python test
and CI keep the two in step. Prices come from a trimmed LiteLLM snapshot in
`src/litellm-snapshot.json`, stamped on every priced output and refreshed with
`prices refresh`. Tags live in a sibling `<db>.tags.duckdb` file written by `tag`
and read by `sessions`, `show` and `sql` as `tagsdb.tags`.

Every command also takes a MotherDuck database, `md:<database>`, in place of a file,
once `pdum-history` has written the same tables there. The token comes from
`MOTHERDUCK_TOKEN` (for example through `node --env-file=.env dist/cli.js ...` or an
exported variable). Tags on MotherDuck live inside the same database as the
`tagsdb.tags` table, so `tag`, `--tag` and `tagsdb.tags` in `sql` work unchanged.
