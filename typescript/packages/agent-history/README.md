# @habemus-papadum/agent-history

Checks, questions and forensics over the DuckDB files that the Python
`pdum-history` ingesters write from Codex homes and Claude Code directories. It
only needs a DuckDB connection, so the same code can later run in a browser
through DuckDB-WASM or against MotherDuck. It never writes a history file.

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
