# 036 — MotherDuck seed: `agent_history` from two local history files

**Observed, 2026-10-18:** the two schema-v4 history files (1.29 GB on disk,
about 500,000 rows, 1.07 GB of item JSON) load into one MotherDuck database
named `agent_history` in 71 s over a single `md:` connection with plain
`INSERT INTO ... SELECT` from the files attached read-only. Every row count and
every text byte sum matches afterwards. Simple queries answer in 25–80 ms
against MotherDuck (1–25 ms locally), two writer processes commit ten
delete-and-insert transactions with no conflict, and replacing one thread
across ten tables in one transaction takes 0.94 s. The one slow path is a
substring search over the blobs: 8.7 s warm on the Standard Duckling against
1.2 s locally. The database stays loaded as the seed for the next stage.

## Question

Can MotherDuck be the record for the tables `pdum-history ingest` writes
locally and the TypeScript CLI reads? Concretely: does the browser token create
databases and write, how long does the 1–2 GB seed take, what do typical
queries cost compared with the local files, do two concurrent ingesters
collide, and how fast is the per-thread replace an incremental ingester needs?

## Main result

| Measure | MotherDuck | Local files |
| --- | ---: | ---: |
| Load, both files, 15 tables | 70.5 s wall (Codex 16.8 s, Claude 51.2 s) | n/a |
| Rows and text bytes after load | identical per source | 500,474 rows, 1,074,510,744 bytes of `item_json` |
| Size reported | 422 MiB (`PRAGMA database_size`) | 1,227.5 MiB (`PRAGMA database_size`), 1.29 GB on disk |
| `count(*)`, monthly usage, session list, point lookup, window | 23–79 ms | 0.7–25 ms |
| `ILIKE '%duckdb%'` over `item_blobs` | 12.5 s cold, 8.7 s warm | 1.3 s cold, 1.2 s warm |
| Two writers, 5 × (delete + insert 10,000 rows) each | 10 of 10 committed, 194–254 ms per transaction | n/a |
| Replace one thread in 10 tables, one transaction | 0.94 s, counts unchanged | n/a |

## Method

Scripts live in [`spikes/036-motherduck/`](../../spikes/036-motherduck/README.md)
and run from the repository root with the production uv workspace, which pins
DuckDB 1.5.6, the newest version MotherDuck supports on the day. The token is
the `MOTHERDUCK_BROWSER_TOKEN` variable of the gitignored `.env`, passed to
`uv run --env-file .env` and then to DuckDB as the `motherduck_token` setting;
it is never printed or stored.

1. `seed.py`: `duckdb.connect("md:")`, `CREATE DATABASE IF NOT EXISTS
   agent_history`, `USE agent_history`, then the contract DDL from
   `pdum.agent_history.schema.ddl()` (15 tables, one view). Each local file is
   `ATTACH`ed `(READ_ONLY)` in the same connection, column parity is checked
   through `information_schema`, and every table is loaded with `INSERT INTO
   agent_history.main.<table> SELECT * FROM <local>.main.<table>`, Codex first.
   A 20-minute budget would have interrupted the statement; it was not needed.
2. `verify.py`: row counts per table and source, plus `sum(length(...))` of
   `item_blobs.item_json`, `items.text` and `logs.body`, MotherDuck against
   each file.
3. `storage.py`: `md_information_schema.storage_info`, `PRAGMA database_size`,
   the `databases` row, per-table estimates and `md_live_duckling_size()`.
4. `latency.py`: six queries, three runs each, first run reported as cold and
   the faster of the other two as warm. The MotherDuck side is a fresh
   `md:agent_history` connection. The local side is an in-memory DuckDB with
   both files attached read-only, one `UNION ALL` view per table and the files'
   own `usage_events` view on top, so the SQL text is identical. Result
   fingerprints are compared.
5. `concurrency.py`: a scratch table `ingest_probe(source_id, thread_id, n,
   payload)`; two child processes, each with its own `md:agent_history`
   connection and `source_id`, stage 10,000 rows in a local temporary table and
   run `BEGIN; DELETE ... WHERE source_id = ?; INSERT ... SELECT FROM
   probe_rows; COMMIT` five times from a shared start instant. The table is
   dropped afterwards.
6. `replace.py`: for one Codex thread, inside one transaction, `DELETE FROM
   <table> WHERE source_id = ? AND thread_id = ?` for the ten tables that carry
   `thread_id`, then re-insert its rows from the attached file; counts per table
   before and after.

## Token capabilities

The browser token connected as user `nehal`, listed the account's databases,
created `agent_history` (type `DEFAULT`, not transient, created 2026-10-18
09:59:46-04), ran DDL, bulk inserts, explicit transactions, deletes, a `CREATE
OR REPLACE TABLE` and `DROP TABLE`, and read `md_information_schema`. Nothing in
this spike was refused. The database is an ordinary database, not a share, and
`duckdb_databases()` shows it as writable.

## Load

| Table | Codex rows | Codex s | Claude rows | Claude s |
| --- | ---: | ---: | ---: | ---: |
| meta | 7 | 0.05 | 7 | 0.05 |
| provenance | 1 | 0.05 | 1 | 0.05 |
| threads | 221 | 0.12 | 539 | 0.07 |
| spawn_edges | 86 | 0.06 | 419 | 0.07 |
| fork_edges | 81 | 0.06 | 54 | 0.06 |
| turns | 1,718 | 0.11 | 2,121 | 0.12 |
| responses | 13,660 | 0.57 | 32,060 | 0.55 |
| token_counts | 14,688 | 0.34 | 30,109 | 0.43 |
| items | 52,676 | 2.31 | 75,496 | 4.42 |
| item_blobs | 52,676 | 12.25 | 50,057 | 38.55 |
| rollout_events | 7,874 | 0.13 | 3,640 | 6.07 |
| response_items | 61,884 | 0.41 | 72,229 | 0.51 |
| logs | 27,403 | 0.20 | 0 | 0.06 |
| coverage | 221 | 0.06 | 539 | 0.07 |
| ingest_runs | 5 | 0.05 | 2 | 0.07 |
| **total** | | **16.8** | | **51.2** |

Connect 0.7 s, `CREATE DATABASE` 0.3 s, DDL 0.7 s, load 70.5 s, whole run
71.5 s. `item_blobs` is 72% of the load: 315 MB of Codex JSON in 12.3 s
(26 MB/s) and 760 MB of Claude JSON in 38.5 s (20 MB/s). Small tables cost about
50 ms each, which is the round trip. The Claude `rollout_events` table took
6 s for 3,640 rows that hold only 0.5 MB of text; nothing in the data explains
it, and a stall on the link during that statement is the likely cause (one run,
not repeated). Afterwards
every per-source row count matched its file and the byte sums of
`item_blobs.item_json` (314,794,939 and 759,715,805), `items.text` and
`logs.body` matched exactly.

## Storage

| Measure | Bytes | GB |
| --- | ---: | ---: |
| `~/history/codex.duckdb` on disk | 396,898,304 | 0.40 |
| `~/history/claude.duckdb` on disk | 890,253,312 | 0.89 |
| `PRAGMA database_size` of the two files | 378.5 MiB + 849.0 MiB | 1.29 |
| `PRAGMA database_size agent_history`, after load | 417.2 MiB | 0.44 |
| `PRAGMA database_size agent_history`, after all probes | 422.0 MiB | 0.44 |
| `md_information_schema.storage_info` | empty for the new database | |

MotherDuck reports a third of the local footprint for identical bytes, so its
storage compresses the JSON text much better than the local files do. The
`storage_info` view, which the docs say powers storage billing, refreshes every
one to six hours and had no row for `agent_history` ten minutes after the load,
so the billable `active_bytes` number is not confirmed here.
`md_information_schema.database_snapshots` already listed seven snapshots.

## Latency

Three runs each, milliseconds; both sides returned the same answers (45,720
responses, 43,853 usage events over 8.78 billion tokens, 8,008 blobs matching
`duckdb`, the same 20 threads and the same cache-read shares).

| Query | MotherDuck cold | MotherDuck warm | Local cold | Local warm |
| --- | ---: | ---: | ---: | ---: |
| a. `count(*)` over `responses` | 26.6 | 23.0 | 2.7 | 1.4 |
| b. monthly tokens and events by source (`usage_events`) | 78.9 | 53.2 | 24.6 | 8.6 |
| c. 20 newest root threads joined to summed usage | 64.0 | 55.3 | 9.0 | 8.9 |
| d. `ILIKE '%duckdb%'` over `item_blobs` | 12,459.1 | 8,650.0 | 1,307.9 | 1,175.7 |
| e. one `item_blobs` row by `thread_id` and `item_id` | 54.6 | 39.4 | 1.2 | 0.7 |
| f. cache-read share by response index, window function | 51.5 | 41.7 | 5.1 | 3.3 |

Connecting to `md:agent_history` took 0.8 s; opening the local union took
19 ms. Everything but the search is round-trip bound on MotherDuck: 25–80 ms
regardless of the work. The search scans 1.07 GB of text; the Standard
Duckling (`md_live_duckling_size()`) did it at roughly 125 MB/s warm, the
laptop at roughly 900 MB/s, and the first MotherDuck run paid another 3.8 s to
bring the table into the instance.

## Concurrent writers

Both processes connected in 0.3 s, started their loops in the same second
(14:05:51Z) and finished in the same second (14:05:53Z); all ten transactions
committed and the table ended with exactly 10,000 rows per `source_id`.

| Worker | Txn | Delete ms | Insert ms | Commit ms | Total ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| probe-a | 1 | 31.8 | 88.1 | 72.2 | 194.0 |
| probe-a | 2 | 65.9 | 67.1 | 96.5 | 230.0 |
| probe-a | 3 | 73.0 | 70.9 | 97.0 | 241.8 |
| probe-a | 4 | 77.4 | 67.1 | 81.8 | 226.5 |
| probe-a | 5 | 78.6 | 68.1 | 93.3 | 241.0 |
| probe-b | 1 | 32.1 | 92.6 | 128.0 | 254.2 |
| probe-b | 2 | 20.5 | 68.0 | 148.5 | 237.4 |
| probe-b | 3 | 23.5 | 67.5 | 152.1 | 244.5 |
| probe-b | 4 | 20.8 | 62.1 | 146.0 | 229.3 |
| probe-b | 5 | 22.3 | 65.1 | 157.4 | 245.6 |

No error text was produced. The two writers deleted and inserted disjoint rows
(their own `source_id`), which is the real ingest situation; the second
worker's commits were consistently 50–70 ms slower than the first's, which
looks like commits serializing on the shared table. Conflicting writes to the
same rows were not exercised.

## Replace one thread

Codex thread `01a0e91c-1649-7801-865e-b834dd84a961`: 592 items and blobs,
591 response items, 63 rollout events, 31 turns, one coverage, thread and
token-count row, no responses or logs.

| Table | Thread rows | Delete ms | Insert ms |
| --- | ---: | ---: | ---: |
| coverage | 1 | 25.5 | 57.1 |
| items | 592 | 25.9 | 100.9 |
| item_blobs | 592 | 26.4 | 83.8 |
| logs | 0 | 24.0 | 25.4 |
| responses | 0 | 25.9 | 58.0 |
| response_items | 591 | 25.3 | 57.4 |
| rollout_events | 63 | 21.2 | 51.3 |
| threads | 1 | 21.9 | 51.8 |
| token_counts | 1 | 22.8 | 52.7 |
| turns | 31 | 22.4 | 52.5 |

Whole transaction 0.94 s including a 102 ms commit. Every table's total and
the thread's rows were identical before and after and equal to the file. The
cost is twenty round trips, not data volume: a delete costs 21–26 ms whether
it removes zero rows or 592.

## Gotchas

- Connection: `duckdb.connect("md:", config={"motherduck_token": token,
  "custom_user_agent": ...})`; the `motherduck` extension (v1.5.6-2026-10-404)
  was already installed and autoloaded. The first connect of the day took
  2.6 s, later ones 0.3–0.8 s. `USE agent_history` before the unqualified DDL
  makes the `usage_events` view bind inside that catalog; later connections use
  `md:agent_history` directly.
- `INSERT INTO agent_history.main.t SELECT * FROM codex.main.t` with the file
  attached in the same connection is all the load needs; MotherDuck's
  documented alternative, `CREATE DATABASE x FROM <local db>`, would have made
  one database per file and was not needed.
- The Python package's `schema.py` moved from version 4 to 5 (new
  `thread_links` and `ingest_ledger` tables) while this spike ran. The seeded
  database holds the version-4 table set of the files; `seed.py` now creates
  only the tables and views the files contain, and the other scripts take their
  table lists from the files' catalogues, not the module.
- `meta` has no `source_id`, so the merged table holds two rows per key
  (`schema_version`, `run_id`, `source`...). Readers of a multi-source database
  should use `provenance`, which has one row per source.
- `md_information_schema.databases` has a `TIMESTAMP WITH TIME ZONE` column;
  `fetchall()` in the DuckDB Python client fails with "Required module 'pytz'"
  unless the column is cast to `VARCHAR`.
- `storage_info` is empty for a fresh database and refreshes every one to six
  hours; `PRAGMA database_size` answers at once. The docs describe its unit as
  kilobytes but the value reads `422.0 MiB`.
- `duckdb_tables().estimated_size` on MotherDuck tables is an estimate
  (103,325 for 102,733 blob rows).
- `md_live_duckling_size()` returned `Standard`. The substring search is the one
  query where instance size would matter.

## Reproduce

See the spike [README](../../spikes/036-motherduck/README.md). Versions: DuckDB
1.5.6 (Python client and engine), MotherDuck extension v1.5.6-2026-10-404,
Python 3.14.7, macOS 26.6.2 arm64, Standard Duckling, files at schema version
4 written on 2026-10-17. Raw timings are in the ignored
`experiments/artifacts/036-motherduck/` (`seed.json`, `verify.json`,
`storage.json`, `latency.json`, `concurrency.json`, `replace.json`); they hold
counts, ids and milliseconds only.

## Limitations

- One account, one region, one laptop on a residential connection, one run of
  each probe. Upload throughput (20–26 MB/s) is a property of this link.
- "Cold" on MotherDuck is the first run in a fresh connection shortly after the
  load, so the instance was already up; "cold" locally is a fresh process with
  the OS page cache warm from the load.
- The concurrency probe wrote disjoint rows; row-level conflicts and more than
  two writers were not tested.
- The billable storage figure (`storage_info.active_bytes`) had not been
  computed when the spike ended.
- Costs are deliberately not estimated.

## Recommendation

MotherDuck can be the record for this data. A full re-seed of 1.3 GB takes
about a minute, a per-thread replace is sub-second, two ingesters writing
different sources do not collide, the browser token has every permission the
ingester and the CLI need, and the reported footprint is 0.44 GB. The
TypeScript CLI's queries (session lists, usage roll-ups, checks) will run
25–80 ms per statement, so interactive commands should batch statements rather
than issue dozens. Two things to design around: keep `source_id` on every row
and treat `meta` as per-file noise, and do not serve substring search from
`item_blobs` on MotherDuck (8–12 s); search `items.text` (79 MB) or a derived
search table there, and keep raw-blob forensics local or on a larger Duckling.
