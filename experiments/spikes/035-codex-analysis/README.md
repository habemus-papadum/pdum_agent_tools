# 035 — Historical analysis: filesystem versus API ingestion into DuckDB

Question: for backend analysis of past and live Codex sessions (usage and cost,
cache behaviour, tool failures, loop detection, text search), what can each access
path see, how fast is it, and what does the client SDK therefore need?

Two ingesters write one DuckDB schema ([`schema.py`](schema.py)); every row carries
`source` (fs, api, live) and `origin` (the concrete input). Analysis is SQL over the
same tables whichever path produced them.

| Script | Role |
| --- | --- |
| `ingest_fs.py` | Reads a Codex home read-only: `state_5.sqlite`, `thread_history_1.sqlite`, `logs_2.sqlite` and every rollout file, including the 2025 pre-envelope format. |
| `questions.py` | The 22 analysis questions as timed SQL. Aggregates only; `prices.json` holds the dated price list. |
| `client.py`, `ingest_api.py` | Read-side app-server RPCs (`thread/list`, `thread/turns/list`, `thread/items/list`, timeline, search, `thread/items/read`) with per-call latency. |
| `run_api.py` | Runs the API ingester against a launcher-started server on a snapshot profile (rollouts cloned, projection copied with the SQLite backup API, or materialized through `thread/resume`) and read-only against the managed daemon. |
| `compare.py` | Row-for-row comparison of API tables against filesystem tables by thread, turn and item id. |
| `live_probe.py` | One `gpt-6-luna` turn in a temporary profile with a subscribed client, then the same thread's persisted rollout through the filesystem ingester. |
| `report_tables.py` | Renders the result tables from one artifact directory. |

Run from `experiments/` with the parent workspace interpreter plus two research-only
overlays that were not merged into any package (DuckDB 1.5.6, pyarrow 26.0.0):

```sh
RUN=artifacts/035-codex-analysis/$(date +%Y%m%d)-run1
PY="uv run --project .. --with duckdb==1.5.6 --with pyarrow==26.0.0 python"
$PY spikes/035-codex-analysis/ingest_fs.py --home ~/.codex --out $RUN
$PY spikes/035-codex-analysis/questions.py $RUN/fs.duckdb --show
$PY spikes/035-codex-analysis/run_api.py --out $RUN --snapshot --concurrency-sweep
$PY spikes/035-codex-analysis/run_api.py --out $RUN --snapshot --history resume --snapshot-threads 40 --sample 0
$PY spikes/035-codex-analysis/run_api.py --out $RUN --daemon --daemon-threads 40 --sample 2
$PY spikes/035-codex-analysis/compare.py --fs $RUN/fs.duckdb --api $RUN/api-snapshot.duckdb --label snapshot
$PY spikes/035-codex-analysis/live_probe.py --out $RUN/live
uv run --project .. python spikes/035-codex-analysis/report_tables.py $RUN
```

The ordinary `~/.codex` is only read. The snapshot profile lives under the ignored
artifact directory and is removed afterwards; the live probe copies the existing
file-backed login into a temporary profile that is removed afterwards. The DuckDB
files contain full conversation text and command output and stay private under
`artifacts/`. The [result](../../docs/spikes/035-codex-analysis.md) records the
coverage, latency and cost evidence.
