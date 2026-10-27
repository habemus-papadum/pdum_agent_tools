# Ingestion and statistics

**24 October 2026 — disposable working application, ready for review.** Open
`http://localhost:56044/ingestion/` while the shared lab is running. This is a
real local ingestion/query experience over selected historical data. It is not
a new ingestor, coordinator service or production SDK.

## Try it

1. Scan six real sessions ordered by known API-equivalent historical cost. Filter
   by provider or search project/native identity; count and known-cost totals
   show the selection against the database. Missing prices remain explicit.
2. Select a row for actual tool groups, errors, usage basis and ingestion coverage.
   Codex context is reported native data. Claude's synthesized response counters
   are not presented as measured context occupancy.
3. Open **Analysis** for existing TypeScript toolkit queries: cost, cache reuse,
   models, commands, context, compaction and coverage. These query the entire
   database independently of the session-table filters. SQL is inspectable.
4. Open **Config** to edit the actual lab `history.yaml`. Save validates through
   the production parser. **Sync saved config** is a separate real incremental
   operation; source completions and errors are observed rather than simulated.
5. **Sources** shows provenance and the ledger; **Runs** shows actual recorded
   phases. Space opens the shared command map. Notes/commentary stay separate
   from the normal application flow.

The header and controls stay compact; the collection/details scroll. Narrow
screens use the same component tree. Configuration becomes a focused panel on a
phone. The existing AIUI dock is explicitly authorized lab scaffolding.

## Existing owners and concrete operations

| UI | Existing implementation |
| --- | --- |
| Native YAML save / resolved sources and targets | `pdum.agent_history.config.load`, including window, blobs, Codex home, Claude directory and launcher profile sources. |
| Incremental sync | `pdum.agent_history.sync.build(..., mode="sync").run()` for each configured source/target; the same operation used by `pdum-history sync`. |
| Sources / phases / coverage | Existing `provenance`, `ingest_ledger`, `ingest_runs` and `coverage` tables. |
| Session measurements | SQL over the existing schema and `usage_events` view, preserving source identity and pricing coverage. |
| Analysis presets / saved pricing | Production `typescript/packages/agent-history/src/questions.ts`, `pricing.ts` and `HistoryDb`; no replacement query package. |

The host's small `/__ingestion/*` adapter invokes the root Python environment for
configuration and ingestion, and the existing TypeScript workspace's `tsx` for
read-only database queries. Node 26's strip-only loader cannot load the existing
toolkit's constructor parameter properties; using its existing runner avoids a
production-code change or extra dependency.

This slice writes only inside its lab directory and does not publish to MotherDuck.
That is a temporary experiment boundary, not a new production configuration
policy. A cloud target produces an explicit unsupported response instead of a
fictional successful sync. Multiple local targets can be synced; the statistical
view currently reads the **first configured target**, named in the footer.
The button performs incremental sync. Changes to parsing/window options may need
the existing CLI's explicit `--full` reread; that operation is not yet exposed here.

## Real data and preparation

The private 058 selection manifest identified four Codex and two Claude transcripts
already reviewed in the history study. `bridge.py prepare` copies exactly those
files into a separate ignored source tree and verifies source/copy SHA256 values.
It copies no credentials, native configuration, entire home, catalogue, native
history projection or asset directory. The original homes are not passed to a
provider process and are not changed.

The first ingest read **161.6 MB** of source files and produced six threads,
7,870 interpreted items and a **76.6 MB** DuckDB file. Source-relative gaps are
visible: Codex catalogue/projection/logs were not collected; its item-completed
rollout fallback provided the items. This is a deliberately selected corpus,
not a representative fleet or complete machine inventory.

From the repository root, with the existing environments installed:

```sh
.venv/bin/python experiments/spikes/061-ingestion-statistics/bridge.py prepare \
  experiments/artifacts/058-native-history-access/long-corpus/selection-final.json
```

Preparation refuses to replace an existing configuration. This private manifest
and its original source files are machine-local; a new checkout must explicitly
supply a selection file with `sessions` containing `provider`, `file` and
`sessionId`. Do not silently substitute a normal agent home. Then start the
shared preview from `experiments/`:

```sh
PORT=0 node spikes/055-orchestrator-mock-lab/serve.mjs
```

Default state: `experiments/artifacts/061-ingestion-statistics/` (ignored).
`PDUM_INGESTION_LAB_DIR` selects a separate absolute directory for preparation and
the preview host, allowing concurrent experiments to use different databases.
The root `.venv` and installed `typescript/` workspace are prerequisites. No
dependencies are merged into the research workspace.

## What the numbers mean

- Known cost is the toolkit's API-equivalent estimate at its **17 October 2026**
  saved LiteLLM price snapshot. It is not actual subscription billing or current
  provider pricing. The initial selected corpus yields **$529.34 known**, with
  **four unpriced usage events**. New inference for this study is **$0**.
- `usage_events` already deduplicates native responses and excludes copied
  context under the production toolkit's current rules. The custom session join
  includes `source_id`. The borrowed preset suite is refused when the same native
  thread occurs under multiple source IDs: several upstream queries join only
  thread/turn identity and need later qualification for that case.
- Codex reported context and Claude response-derived counters differ. The session
  table leaves Claude context unknown; Q6 and Q12 are narrowly qualified to Codex
  with that restriction visible in their titles and SQL. No production parser or
  schema was changed.
- A recorded nonzero command exit or error is a historical observation, not a
  current unhealthy-agent judgment. Reported durations can overlap and do not sum
  to session wall time. See RC-09/RC-10 in the runtime-contract ledger.

## Boundaries and follow-up

The frontend is real Solid/AIUI: scoped controls/actions, cells, durable view state,
source tooling and the command map. Session filtering is a small in-memory
projection of the server's aggregate rows. **Mosaic crossfilter is not implemented
here.** There is no pretend crossfilter, streaming phase percentage, automatic
source watcher, cancellation contract, cloud upload, live authentication or
native-history continuation. The browser only receives aggregate/query results,
not all raw transcripts.

Sync exposes real source boundaries; the current ingestor provides phase timings
after a source completes, not granular progress events. The host keeps the latest
observed job in its lab directory. After a host restart, an unfinished observation
is marked unknown. Seamless recovery and detached execution are not claimed.
Use different lab directories for concurrent writers. Unknown outcomes are not
automatically replayed (RC-07).

Questions for the next iteration: which analysis questions deserve graphical
Mosaic views; selection across those views; choosing among target databases;
which ingestion errors should be actionable; remote source discovery; and linking
an aggregate result to the native historical view (Round C). The ordinary flow
and native configuration owner are concrete enough to review before extraction.

## Focused validation

The initial real ingest succeeded. A subsequent browser-triggered sync skipped
all six unchanged files and retained the six threads. The browser helper checks
actual data, filtering, source-specific context, SQL results, invalid YAML without
mutation, a reversible config-save round trip, real incremental sync, and source/
run views. It can be run from an isolated preview tab:

```js
await (await import('/061-ingestion-statistics/ingestion.browser-check.mjs'))
  .runIngestionBrowserChecks()
```

All **18 focused browser checks passed at 390×844**. The deliberately invalid
configuration produces an expected HTTP 400; the final run had no Solid warnings
or unexpected browser errors. Typechecking and Python Ruff check/format passed;
desktop and phone layouts were inspected. An actual concurrent start check returned
one accepted HTTP 202 and one refused HTTP 400, completed one sync with six unchanged
units, and preserved the configuration. This intentionally is not a comprehensive
production test suite. Native source evidence remains in ignored `source-evidence.json`; private
transcript text, database contents and source paths are not committed as fixtures.
