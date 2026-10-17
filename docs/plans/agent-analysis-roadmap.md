# Agent history and analysis roadmap

**Status: direction notes, 16 October 2026; stages 1, 2 and 4 landed on 17 October 2026, followed the same day by schema version 3 with provenance, tags, repo, cache tiers and LiteLLM pricing, then schema version 4 with fork edges and lineage ids** as `habemus-papadum-agent-history` and `@habemus-papadum/agent-history`, see the [guide](../agent-history.md). The two items left open after version 3, Claude lineage and the cost-state disagreement, are closed below under "Lessons from cc-miner"; Claude's `cleanupPeriodDays` on this machine was raised to 365 on 17 October 2026. This records what the
launcher round and spike 035 taught us, the policy we agreed for old data, the
three agent runtimes we intend to support, and a staged path toward one set of
tools that serves a person at a desk, a swarm on cloud machines, and a browser.
Nothing here authorizes a package release.

## Lessons learned

- **Native storage is the record; the agent API is a view.** Codex's rollout
  files hold per-response usage, rate limits, turn settings and fork lineage
  that no read RPC returns. The RPCs serve a SQLite projection of the same
  files, so items match byte for byte but facts are missing, not different.
- **One schema, several ingesters.** Rows carry a `source` and an `origin`, and
  every ingest writes a `coverage` row per thread. The same SQL then answers a
  question from files, from a server, or from a live subscription, and says
  which input it could not see.
- **Extract once, purely.** The column extraction for an item is one function
  with no I/O, shared by the projection reader, the RPC pager and the live
  notification handler. Spike 033 reached the same conclusion for usage.
- **Measure what is there and label what is not.** Cost is a dated list-price
  proxy with an unpriced share. Command item durations are wrong for unified
  exec, so tool latency comes from the raw call and output pairs instead.
  Counter deltas stand in for missing usage records and say so in a column.
- **Drift is normal.** Seven 2025 rollouts use an older format, `thread/items/read`
  exists on 0.163 but not 0.162, `thread/list` hides threads for reasons the
  server does not state, and a fresh home never materializes history it did
  not write. Expect this from every runtime and plan to notice, not to absorb.
- **Prefer servers we launched; touch the shared home read-only.** The daemon
  works for read probes but serves other clients and restarts hourly. A
  snapshot profile needs the projection copied before its API returns history.
- **Keep research dependencies out of packages.** DuckDB and pyarrow ran as
  `uv run --with` overlays. The DuckDB files hold full conversation text and
  stay in ignored artifacts; personal spend figures stay out of committed docs.
- **Small traps worth remembering.** A WAL database refuses a read-only open
  while nobody holds its `-shm` file. Codex wraps every command in a login
  shell, so the program name needs unwrapping. Item pages cap at 100 and
  concurrency does not help a single server.

## Policy for old data and schema drift

- Support the most recent six months of history for each runtime, which today
  reaches back to April 2026. For this corpus the interesting window starts in
  July 2026 and every file in it uses the current Codex envelope format.
- Older files are counted, not modelled. The ingester records their format and
  line counts in `coverage` and moves on. We do not write adapters for retired
  schemas.
- Every ingest ends with an invariant check that prints numbers a person can
  eyeball. Examples: per-thread usage records sum to the thread's cumulative
  counter; projection items equal `item_completed` events; turns with usage are
  a subset of turns with a context record; unknown line types inside the window
  are zero; applied database migrations equal the versions we last saw; the
  server lists at least as many threads as the catalogue minus known filters.
- A failed invariant is a planning item, not a hot fix. It opens a separate
  Claude Code or Codex session whose job is to decide whether the change needs
  a special case, a schema bump, or a shorter window.
- This is deliberately not robust. It is meant to surface problems when two
  numbers that should agree do not, which is enough while the tools have one
  user.

## Three runtimes, one tool set

| Runtime | Launch layer today | Record of a session | Live steering surface | Analysis path |
| --- | --- | --- | --- | --- |
| Codex CLI and app-server | `pdum-codex` profiles, `--default`, inspect, run records | Rollout JSONL plus SQLite catalogue, projection and logs under the home | App-server JSON-RPC over the launched socket; notifications while subscribed | Filesystem ingester done in spike 035; API and live ingesters measured |
| Claude Code | `pdum-claude` profiles, workers, observation hub, MITM | Per-project session JSONL under the config directory, sub-agent files beside each session | Agent SDK over the relay; hooks and the observation processors | Not started; format surveyed below |
| OpenAI Agents TypeScript SDK | None | Whatever the host writes: the SDK exposes trace processors and a session interface | The SDK's own run loop in Node or a browser | Not started; would write the schema directly |

The Claude Code format is close enough to share the schema and different enough
to need its own ingester. Each assistant line carries the model, effort and a
usage block with cache creation and cache read counts, so cost and cache
questions work per message rather than per response. Lines form a tree through
`uuid` and `parentUuid`, sub-agents are sidechains in separate files, tool calls
and results are content blocks paired by id, and turns are derived from prompt
ids because no turn record exists. The session also stores the API request
shapes it sent, which no Codex record has and which makes cache analysis
direct. Your store holds 538 session files, 420 of them sub-agent files.

## How much data

Measured on this machine on 16 October 2026, read-only:

| Store | Window | Files | Raw size | Rate at current use |
| --- | --- | ---: | ---: | ---: |
| Codex rollouts | September and October 2026 | 186 threads | 770 MB | about 500 MB per month |
| Codex rollouts | September 2025 to July 2026 | 35 threads | 17 MB | negligible |
| Claude Code sessions | September and October 2026 | 538 files | 1.24 GB | about 600 MB per month |

Per Codex thread the median rollout is 1.1 MB, the 95th percentile 14 MB and the
largest 140 MB. Per Claude file the median is 1 MB, the 95th percentile 7.5 MB
and the largest 98 MB. Almost all of it is blob: command output, MCP results,
diffs, message text, encrypted reasoning and world state. The structured facts
that answer the analysis questions are small. The spike's DuckDB file is 209 MB
with command outputs and 104 MB without them, and the usage, turn, timing and
identity tables inside it are a few megabytes. A fair planning figure for one
heavy user across both runtimes is about one gigabyte of raw history per month,
of which perhaps 50 to 100 MB are facts worth keeping in MotherDuck and the rest
belongs in object storage addressed by hash, size and URL. A swarm scales by the
same per-run numbers: a thousand short runs are one to ten gigabytes raw.

## Directions

**Horizontal: Claude Code into the same schema.** A filesystem ingester for the
Claude session store, an invariant set, and the same questions. Differences get
their own columns rather than a second schema: cache creation tokens, request
shapes, sidechain flags, parent links. This is the cheapest next step and it
tests whether the schema is really runtime-neutral.

**Forensics on one session.** Reloading a trace to see how the agent approached
a problem needs turn summaries, tool timelines, diffs and the message text, not
cache arithmetic. That is a set of SQL views over the ingested tables plus a
terminal renderer that prints one session as turns. It needs no agent process
and no new data, so it is less ambitious than the spikes and can start as soon
as the schema is packaged.

**A third runtime in the browser.** The Agents SDK can run in a browser with a
trace processor that writes spans and a session store that writes messages.
If MotherDuck is the record, the browser writes facts directly through its
WebAssembly client and puts blobs in object storage with presigned uploads.
That is a different trust boundary from the launchers, which hold credentials
on the host, so it needs its own credential story before it is more than a
demo.

## Staged plan

1. **Package the schema and the Codex ingester.** Lift `schema.py`, `items.py`
   and the filesystem ingester out of the spike into a small package with a
   CLI: ingest a home, run the invariant check, run the questions, attach or
   push to MotherDuck. Keep DuckDB as a real dependency there and nowhere else.
   Apply the six-month window and the drift policy from the start.
2. **Add the Claude Code ingester.** Same package, same tables, Claude-specific
   columns and invariants. The two launchers already know where their homes
   are, so the CLI can ingest every profile it manages.
3. **Make MotherDuck the shared store.** Local DuckDB files remain the working
   copy; a push appends facts with run, host and profile identity. Blobs go to
   object storage with a reference table. This is where cross-filtering with
   Mosaic and multi-machine swarms become possible without new ingest code.
4. **Build the forensics views and renderer.** SQL views for turn summaries,
   tool timelines and diffs, and a terminal command that prints one session.
   A web viewer later reads the same views from MotherDuck.
5. **Stream live sessions into the same tables.** The Codex API ingester in
   subscription mode and the Claude observation hub append rows as a session
   runs. The detectors from the question set run on a timer over those rows,
   and the steering client reads them. Per-turn model and response ids still
   come from the files afterwards.
6. **Add the Agents SDK runtime.** A Node host first, using the launcher's run
   records and the same ingester; a browser build second, writing to MotherDuck
   directly. Only then do all three runtimes run in all three settings.

Swarms on cloud machines are the launcher pattern repeated: every run owns a
profile, finishes, and its home is ingested by a collector that pushes facts
with run identity. A person at a desk runs the same ingest against their own
homes on a schedule. The browser case is the exception that writes facts
directly and therefore gets a thinner schema until the credential story exists.

## Provenance, annotations and ingestion from many machines

Written 17 October 2026 after comparing the first ingesters with cc-miner. The
ingesters should stay simple; provenance is a few stable identifiers written at
ingest time, and annotations live outside anything an ingest rebuilds.

**Identity.** Every fact row gets one narrow `source_id` column that names the
ingest source, and a `provenance` table describes each source once: a `host_id`
minted on first use and stored under the launcher's own data directory, never in
the agent's home, with the hostname as a label that may change; the operating
system user; the agent kind and the root directory read; the versions seen; the
window cutoff, schema version and ingester version. cc-miner reached the same
conclusion the hard way: a hostname is a label, never a key, because a rename
forks one machine's history into two. Thread, turn, response and item ids are
UUIDs or provider ids and are already unique across machines, so merging is a
union with `source_id` as the discriminator and needs no id rewriting.

**Slicing.** Machine and user come from `provenance`; directory, branch and
repository already sit on `threads`. Add a normalized `repo` column (owner and
name from the origin URL) at ingest, since repository is the grouping a person
reaches for first and URL spellings vary. Anything finer is a tag.

**Annotations.** A separate annotations database holds one `tags` table:
subject kind (thread, turn, item, source), subject id, key, value, author and
time. Tags are written by analysis tooling and by hand, never by an ingester,
and the subject ids are stable, so a tag survives a rebuild of the history file
and a move to MotherDuck. Query code attaches the two databases and exposes a
view with the tags of a thread as a DuckDB `MAP`. A CLI verb that sets and
lists tags is the first consumer.

**Rebuild versus append.** Today an ingest rebuilds its DuckDB file. That is fine
while the agent's own store is the record, and wrong once it is not: Claude Code
deletes transcripts after its cleanup period, which defaults to 30 days, and
the oldest file on this machine is from 9 September 2026 while cc-miner's
June and July corpus survives only as Parquet. Two consequences. First, raise
`cleanupPeriodDays` in Claude's settings so the six-month window has data to
read, which is the operator's call and was done on this machine (365 days) on
17 October 2026. Second, stage 3 should write per-source,
per-month Parquet partitions and overwrite only the current month, as cc-miner
does with `username=/host=/month=` partitions and an index file, so an ingest
is incremental and a laptop cannot clobber a desktop. The DuckDB file then
becomes a view over partitions, locally or on MotherDuck.

## Lessons from cc-miner

cc-miner (`~/src/cc-miner`, Claude Code only, Parquet grains, July 2026) solved
several problems this tool has or will meet. Its July corpus has no session in
common with the files on disk today, so the comparison is of method, not rows.

- Price from the LiteLLM table, not a flat list. LiteLLM's JSON carries a
  one-hour cache-write rate for Claude models and a long-context input rate for
  OpenAI models, keyed by model id and refreshed daily. cc-miner rejected
  `genai-prices` because it models cache writes as one bucket; on its corpus
  48% of cache-creation tokens were the one-hour tier. Here it is 37%, and the
  current flat five-minute pricing understates Claude spend by about 9%. The
  shared schema needs a `cache_write_1h_input_tokens` column and the price
  table needs a version stamp per row, which cc-miner calls `pricingVersion`.
  There is no dedicated Python pricing library worth adding: `tokencost` is
  stale, `litellm` is a 106-dependency client, and `genai-prices` is the same
  single-bucket model. Fetching the LiteLLM JSON and pinning its date is enough
  in either language.
- Take the member with the most output when a Claude message is split across
  records. Sub-agent transcripts write placeholder output counts on earlier
  blocks and the true count on the last; a fork copy can carry a zero with the
  same timestamp. Max is order independent and right in every case they found.
- Price over the `iterations` ledger when it has more than one entry, since a
  model fallback hides the discarded attempt there. In the current corpus every
  ledger has one entry, so this is a guard, not a correction.
- Lineage, done in schema version 4 on 17 October 2026. cc-miner's corpus made
  the `session_id` marker a confirmation rather than the decision because its
  builds left user records unmarked, so the last marked record could name a
  grandparent. On the builds here (2.1.265 and later) user and assistant
  records both carry the marker, and every foreign-marked uuid in the corpus
  exists in the file it names, so the marker decides ownership and the last
  foreign producer before a file's own messages is its direct parent. The
  `continued-in` record confirms the edge or stands alone when the successor is
  gone; files without markers fall back to uuid overlap with the direction
  flagged ambiguous; sub-agents since 2.1.220 reference the parent's context
  (`fork-context-ref`) instead of copying it. Two traps found on the way: a
  continued session answers the prompt it inherited with responses of its own,
  so an inherited turn must never mark its responses as copies (that had hidden
  139 responses); and a `continued-in` record is stamped when the successor
  starts, often days later, so it must not extend the last turn. The result is
  `fork_edges`, `threads.lineage_id` and `lineage_depth`, with sub-agents in
  their session's lineage; 22 of 89 Claude lineages here span more than one
  file.
- Cost-state, explained the same day. Claude's ledger starts with the process and
  is carried into continued sessions, so a snapshot has to be compared with its
  ancestor chain up to each branch point. Done that way, the remaining excess
  is side requests the transcript never records as responses: away summaries
  (`system:away_summary`, correlation 0.82 with the cache-read excess),
  compactions (0.64) and title generation. With neither in the chain most
  snapshots agree within two percent. The check stays informational.
- Record what the transcript says about itself. Done: aborted-mid-stream events,
  skill names on tool items, MCP server names, and a duty cycle question (Q24)
  from a 30-minute idle gap over prompts and responses. Not done: estimated
  image tokens from image headers; `image_count` is as far as we go.
- Keep the corpus outside the repository and outside any build artifact; cc-miner
  once shipped 121 personal transcripts inside a desktop app bundle.

## Decisions to take before stage 1

- Package name and location: a new `pdum.agent_history` package, or a module
  inside each launcher. One package is simpler for a shared schema.
- Whether MotherDuck is the record or a mirror of local files. The plan above
  assumes a mirror until the browser runtime needs a record.
- Which blob classes to keep locally only: command output and MCP results are
  the bulk; diffs and messages are what forensics reads most.
- Whether the Claude ingester should store the API request shapes, which make
  cache analysis exact but add volume.
