# habemus-papadum-agent-history

Ingest agent session history into DuckDB with one shared schema. The Codex ingester
reads a Codex home read-only: the thread catalogue, the history projection, the log
database and every rollout file. The Claude ingester reads a Claude Code
configuration directory: every session file and every sub-agent file beneath it,
workflow agents included. Facts land in small tables (threads, turns, responses,
token counts, items, events); full item JSON, tool calls with their results and
message blocks land in `item_blobs` so a later move to MotherDuck can relocate
blobs without touching the facts.

```sh
uv run pdum-history sync --example            # a per-machine history.yaml to fill in
uv run pdum-history sync                      # every Codex home, Claude dir and launcher profile into every target
uv run --env-file .env pdum-history sync --target cloud   # a MotherDuck target, token from the environment
uv run pdum-history ingest codex --db ~/history/codex.duckdb      # one source into one fresh file
uv run pdum-history ingest claude --db ~/history/claude.duckdb --sync
uv run pdum-history schema --json
```

A sync is incremental: the target's `ingest_ledger` remembers each file's size,
modification time and fingerprint per source, only new or grown files are parsed, each
changed thread's rows are replaced in one transaction, and files that vanished from the
agent's store are marked gone while their rows stay. Targets are local DuckDB files or
`md:<database>` on MotherDuck.

`fork_edges` records which thread inherited context from which (continued Claude
sessions by their `session_id` markers and `continued-in` records, sub-agent forks,
Codex forks from the rollout's first line) and every thread carries `forked_from_id`,
`lineage_id` and `lineage_depth`, so one lineage is a session as a person means it.

Every row carries a `source_id` and a `provenance` row records the machine
(`host_id` minted once under the launcher's data directory), user, agent, root,
versions and window of each ingest, so files from several machines merge by union.

Threads older than the support window (183 days by default) are listed in
`coverage` with `in_window = false` and otherwise skipped; older storage formats
are counted, not modelled. Every row carries `source` and `origin`; lines a Claude
file copied from another session or a parent carry `origin = 'copied-context'`
and stay out of usage. The `usage_events` view returns per-response usage where
it was recorded and positive deltas of cumulative counters otherwise.

Query, invariant and forensics code lives in the TypeScript package
`@habemus-papadum/agent-history` under `typescript/`, which keeps a copy of this
schema and fails a parity test when the two drift. The Python package exposes
`ingest_codex_home`, `ingest_claude_dir`, `CodexIngest`, `ClaudeIngest`,
`IngestSummary` and `schema.describe`. See the repository
[guide](https://habemus-papadum.github.io/pdum_agent_tools/agent-history/).
