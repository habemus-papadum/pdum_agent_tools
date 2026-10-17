# 035 — Historical analysis: two ingesters, one DuckDB schema

**Observed, 2026-10-16:** every analysis question in the brief is answerable in
single-digit milliseconds from a DuckDB file that a read-only filesystem ingester
builds from a real Codex home in under eight seconds. The read RPCs of a running
app-server return the same turns and items byte for byte, but no usage, no
rate limits, no per-turn model and no fork lineage, so the cost and context
questions need the rollout files or a live subscription. The two paths are
complementary ingesters into one schema, not alternatives.

## Question

For backend analysis of past and live sessions (cost and usage, cache growth,
tool failures, loop detection, text search, sub-agent economics), what can the
ad hoc path (SQLite and rollout files) and the client path (app-server RPCs
and notifications) each see, how fast are they, and what should the client SDK
therefore implement? The 22 questions came from the design round on
2026-10-16 and are coded in
[`questions.py`](../../spikes/035-codex-analysis/questions.py).

## Main result

| Path | Threads | Usage per response | Tool items | Turn model and effort | Search | Wall time for the home |
| --- | ---: | --- | --- | --- | --- | ---: |
| Filesystem (`ingest_fs.py`) | 221 | 13,540 records plus counter deltas for older threads | 52,648 | 907 turns | 214 ms substring over all text and output | 7.6 s |
| Launched server on a snapshot profile | 157 | none | 36,090 | none | 72 ms over name, title and preview | 13.8 s for 657 calls |
| Managed daemon, read-only, 40 threads | 157 listed | none | 10,709 | none | 80 ms | 2.7 s for 181 calls |
| Live subscription, one Luna turn | 1 | cumulative totals per response | 3 | none | n/a | 8.0 s turn |

Items that both paths saw matched exactly: 35,876 shared items with zero
mismatches in type, duration, output size, text length or status, because the
RPCs serve the same SQLite projection the filesystem ingester reads. The API
path differs only in what it omits.

## What the data holds

- Per-response usage (`token_usage_record`) exists for 126 of 221 threads, all
  from September 2026 onward. Older threads have only cumulative `token_count`
  events. Positive deltas of those counters reproduce the per-response totals
  within 1.7% in aggregate and within 1% for 84 of 126 threads that have both.
  The ingester exposes both as a `usage_events` view with a `basis` column.
- Model and reasoning effort live in per-turn `turn_context` lines, not in the
  catalogue (null for 76 of 213 catalogue rows) and not in any RPC response.
- Every `token_count` event carries the weekly rate-limit window and the credit
  balance, so rate-limit pressure and credit drawdown are a time series for
  free: 16,454 points here.
- Command items from unified exec complete at process startup. 6,812 of 11,457
  completed command items have zero item duration. The real tool wall time is
  recoverable from the raw `custom_tool_call` and output pairs by call id:
  p50 9.7 s, p95 78 s for `exec`. Per-command duration from items alone is wrong.
- Sub-agent children hold 52% of the tokens in the 12 families that spawned
  them (86 children), and 220 of their rollout turns never reach the projection.
- Compaction shows up as 151 `compacted` records in 65 threads, with mean context
  dropping from about 204k to 26k tokens; cumulative counters do not move.
- Forks are sub-agent spawns in this corpus: 80 of 81 forked rollouts also
  carry a parent thread id. `thread/list` never reports `forkedFromId`
  (73 forks hidden); only the rollout's `session_meta` does.
- Seven 2025 rollouts use the pre-envelope format and yield counts only.

## What the API path omits or needs

- `thread/list` returned 157 of 213 catalogue threads from both servers. The 56
  omitted were 40 archived threads written by a VS Code alpha build with no
  recorded originator, 14 unarchived sub-agent children without a preview and
  two 2025 CLI threads. The filter is server-side and was not identified.
- A fresh home catalogues cloned rollouts in under two seconds but never
  materializes their SQLite history, so `thread/turns/list` and
  `thread/items/list` return nothing. `thread/resume` materializes one thread in
  about 60 ms but refuses archived threads (34 of 40 attempts). Copying
  `thread_history_1.sqlite` with the SQLite backup API took 0.43 s for 362 MB and
  made every read work. `codex migrate-rollouts` does not help: 213 of 221 files
  were already paginated.
- Page size is capped at 100 items regardless of the requested limit.
  Concurrency does not help: on 40 threads, 1, 4 and 8 in-flight requests took
  1.9, 1.7 and 1.7 s while per-call p50 rose from 3 to 29 ms.
- `thread/items/read` is rejected by 0.162.1 and served by 0.163.0, so a client
  must gate experimental methods on the server version.
- Usage reaches a client only while subscribed: two `thread/tokenUsage/updated`
  notifications matched the two persisted per-response records exactly, but
  the client never sees response ids, the model, effort or time to first token,
  and `rawResponse/completed` is not delivered.

## Reproduce

See the spike [README](../../spikes/035-codex-analysis/README.md). The ordinary
home is only read; the snapshot profile and the temporary live profile are
removed afterwards. Versions: codex-cli 0.162.1 for the launched servers, daemon
0.163.0, vendored source `6c372fb`, DuckDB 1.5.6, pyarrow 26.0.0, Python 3.14.7,
macOS 26.6.2 arm64.

## Evidence

Filesystem ingest of 221 rollouts (788 MB) and three databases:

| Phase | Seconds | Rows |
| --- | ---: | ---: |
| catalogue | 0.03 | 213 |
| projection | 4.24 | 52,648 |
| rollouts | 3.11 | 160,241 lines |
| logs | 0.08 | 25,946 |
| total | 7.56 | 209 MB DuckDB file |

Every question except full-text search ran in 0.7 to 15 ms warm; the search
took 198 ms over 52,648 item texts and 11,288 command outputs. Selected
aggregates (the private `questions.json` holds the full output):

| Question | Aggregate |
| --- | --- |
| Cache growth | cache-read share rises from 0.83 at the first response of a turn to 0.96 by the tenth; mean input per response about 100k tokens |
| Context | p50 peak context 124k tokens, p95 244k; 33 threads passed 80% of the window |
| Tools | 12,603 command executions, 9.1% nonzero exit; 1,842 MCP calls with p50 109 ms and 58 errors; collab waits p50 24 s |
| Turns | 784 completed turns with duration: p50 202 s, p95 30 min; time to first token p50 3.6 s; mean 20.8 responses per turn |
| Loops | 64 turns with more than 50 responses (mean 89); 11 turns repeated one command five or more times |
| Rhythm | local-hour histogram works (DuckDB ships ICU); median think time between turns 8.5 min |
| Limits | the weekly window reached 100% on one day and credits were drawn only that day |
| Edits | 1,915 file changes; 458 paths edited three or more times within one thread |
| Detectors | 2 turns still in progress, 15 turns over 90% of the window, 64 warnings or errors in the last 7 days, 3 failed turns (all token refresh) |

API latency per method, launched server with the copied projection, all 157
listed threads:

| Method | Calls | p50 ms | p95 ms | Total ms |
| --- | ---: | ---: | ---: | ---: |
| thread/list | 3 | 64 | 267 | 382 |
| thread/turns/list | 162 | 0.7 | 1.6 | 310 |
| thread/items/list | 454 | 2.7 | 6.7 | 8,482 |
| thread/timeline/list | 25 | 3.4 | 4.9 | 87 |
| thread/search | 1 | 72 | | 72 |

The daemon served the same methods about twice as slowly while also serving
VS Code (items p50 6.4 ms, turns 2.4 ms).

Live turn: `thread/start` 721 ms, turn 8.0 s, 26,228 tokens of which 17,920
cached, API-equivalent USD 0.001 at the 2026-10-16 Luna rates. The source
login file was unchanged.

## Limitations

- One home, one user, mostly `gpt-6-astra` at xhigh effort. Latencies are a
  single run on an M-series laptop with other servers active.
- Cost is an API list-price proxy from `prices.json` (Astra, Luna, Sol, 6.1 Sol
  on 2026-10-16). Subscription billing is not an invoice; 2025 usage has no
  recorded model and stays unpriced rather than imputed.
- The delta fallback counts a fork's first counter value as new usage, which
  can include inherited history; this corpus has no non-sub-agent forks.
- Live analysis was one turn; detectors over a live stream were not exercised.
- Opening `state_5.sqlite` read-only fails while no writer holds its `-shm`
  side file (SQLite error 14). The ingester falls back to a query-only
  connection, which creates the side file Codex itself creates.

## Consequence for the client SDK

- Define the schema and the pure extraction (`items.py`) once; ship a
  filesystem ingester as the complete historical source and an API ingester for
  remote or live use, each tagging provenance and writing a `coverage` row.
- Treat usage, rate limits, turn settings and fork lineage as filesystem-only
  facts; the API ingester fills them only from live notifications it subscribes
  to from the start.
- Store the DuckDB file; it attaches to MotherDuck unchanged, and the extracted
  columns without command outputs are a fraction of the 209 MB.
- A snapshot server for tests needs the projection copied or the threads
  resumed; cloning rollouts alone gives an empty history API.
