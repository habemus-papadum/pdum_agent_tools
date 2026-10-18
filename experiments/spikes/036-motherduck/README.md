# 036 — MotherDuck seed: `agent_history` from two local history files

Question: can a MotherDuck database be the record for the agent-history tables
that `pdum-history ingest` writes locally? Load the two schema-v4 files
(`~/history/codex.duckdb`, `~/history/claude.duckdb`, about 1.3 GB together)
into one database named `agent_history`, measure the load, typical queries,
two concurrent writers and the per-thread replace pattern, and leave the data
in place as the seed for the next stage.

| Script | Role |
| --- | --- |
| `common.py` | Token from `MOTHERDUCK_BROWSER_TOKEN`, `md:` connection, local attach, union-view baseline, timing and artifact helpers. The token is never printed or written. |
| `seed.py` | `CREATE DATABASE IF NOT EXISTS`, the contract DDL from `pdum.agent_history.schema`, `ATTACH ... (READ_ONLY)` of each file and `INSERT INTO agent_history.main.<table> SELECT *` per table with a wall-clock budget; row-count verification; storage from `md_information_schema.storage_info` and `PRAGMA database_size`. |
| `latency.py` | Six queries, three runs each, against `md:agent_history` and against an in-memory DuckDB that unions both local files; checks both sides agree. |
| `concurrency.py` | Two writer processes on a scratch table `ingest_probe`, five `BEGIN; DELETE; INSERT 10,000 rows; COMMIT` each, then the table is dropped. |
| `replace.py` | One Codex thread deleted and re-inserted from the local file inside one transaction, with before/after counts. |
| `storage.py` | What MotherDuck reports afterwards: `storage_info`, `PRAGMA database_size`, database type, per-table estimates, Duckling size. |
| `verify.py` | Row counts and text byte sums per source, MotherDuck against the local files. |
| `report_tables.py` | Renders the Markdown tables for the summary from the artifact JSON. |

Run from the repository root with the production workspace interpreter (DuckDB 1.5.6
is pinned there; the gitignored `.env` holds the token):

```sh
PY="uv run --frozen --all-packages --env-file .env python -u"
$PY experiments/spikes/036-motherduck/seed.py
$PY experiments/spikes/036-motherduck/latency.py
$PY experiments/spikes/036-motherduck/concurrency.py
$PY experiments/spikes/036-motherduck/replace.py
$PY experiments/spikes/036-motherduck/storage.py
$PY experiments/spikes/036-motherduck/verify.py
uv run --frozen --all-packages python experiments/spikes/036-motherduck/report_tables.py
```

`seed.py` skips a source whose rows are already present; `--force` deletes
that source's rows first and `--only codex|claude` restricts the run. The
local files are only read. Raw timings land in the ignored
`experiments/artifacts/036-motherduck/`; they hold counts, ids and
milliseconds, never conversation text or the token. The
[result](../../docs/spikes/036-motherduck-seed.md) records the numbers.
