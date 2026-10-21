# HP behavioral integration: coding and model-selected browser delegation

**Observed 18 October 2026:** HP and native Codex both repaired the same small
JavaScript project and passed all eleven independent gates. HP also delegated a
real application calculation to a child in Node and Chrome, then updated the
application with the child's result. These are small feasibility checks, not a
general coding benchmark.

Read the [combined behavioral findings](../../../docs/hp-agent-behavior.md) first.
Dependencies are the [042 tools](../042-hp-tools-skills/README.md), existing 038
Responses connector, 039 runtime/history and 041 prompt adapter. Real compaction
is qualified separately in [043](../043-hp-context-compaction/README.md).

## Coding task and observed comparison

Both arms received identical `hp-mini` prompts and initial projects, prepared by
[044](../044-hp-evaluation/README.md). The task required reading an explicit local
skill, repairing identity/revision/cache/inherited-history/order bugs, adding at
least four tests, running them, and documenting the rules. The independent
checker stayed outside the agent's project. No operator edited either project
during execution. Only source, tests and README changed.

| Observation | HP | Native Codex |
| --- | ---: | ---: |
| Independent gates | 11/11 | 11/11 |
| Agent-created regression tests, actually run | 5 | 6 |
| Wall seconds | 25.68 | 23.35 |
| Recorded model responses | 10 | 4 |
| Tool calls | 9 | 11 |
| Recorded tool-output bytes | 11,638 | 4,080 |
| Largest recorded input | 9,960 | 13,345 |
| Output tokens, including reasoning | 2,146 | 2,340 |
| Reasoning tokens (included above) | 96 | 87 |
| Estimated API-equivalent USD | 0.002965455 | 0.003178000 |

Both used exact `gpt-6-luna`, low reasoning, default service, sandbox off and
approvals off. They ran sequentially. HP used the pinned model text and public
Responses translation, with 042 Node tools and explicit skill loading. Native
Codex used its own prompt assembly and code-mode tool execution. Grouping,
framing, tool results and cache state therefore differ; the table does not imply
an identical harness or an efficiency ranking from one observation.

### Native prerequisite failure and corrected baseline

The first native run used our clean source build (`6c372fb...`, `codex-cli 0.0.0`).
That build lacked its separate `codex-code-mode-host`; the agent correctly
reported it could not read or edit files. CLI exit was zero, but the independent
task checks failed. Its four recorded response rows cost an estimated
USD 0.001825750 and remain in the ledger. It is an environment failure, not a
quality result against HP.

Building the missing host with `cargo build --locked -p codex-code-mode-host
--bin codex-code-mode-host` failed because the V8 150.4.0 macOS arm64 prebuilt
archive returned HTTP 404. We did not start a V8 source build or mix helper
binaries from different versions. The corrected arm used the installed complete
**Codex 0.163.0** distribution and its own matching helper, in a fresh profile and
scratch project. The manifest records both executable hashes. This version
differs from HP's pinned prompt/source reference and is stated explicitly.

The native harness now checks its prompt and helper before inference. Four
credential-free fake-executable tests cover missing-input preflight, a capture
write error after spawn, flushed output, signal handling and cleanup of a
TERM-ignoring descendant. Cleanup uses only the process group launched by the
harness; no process-name searches or developer-session cleanup is involved.

## Run a new coding comparison

From the repository root, choose fresh run IDs:

```sh
uv run --frozen python experiments/spikes/044-hp-evaluation/prepare.py \
  --run-id NEW_HP_RUN --agent hp --model gpt-6-luna --effort low
uv run --frozen python experiments/spikes/044-hp-evaluation/prepare.py \
  --run-id NEW_CODEX_RUN --agent codex --model gpt-6-luna --effort low
```

Run these separately from `experiments/`, with a host API key (the shown `.env`
is ignored and is never copied into a profile or result):

```sh
node --env-file=../.env --import tsx spikes/045-hp-behavior/cli.mjs \
  --run-dir ~/history/evals/NEW_HP_RUN
HP_CODEX_BINARY=/path/to/complete/codex node --env-file=../.env \
  spikes/045-hp-behavior/native.mjs --run-dir ~/history/evals/NEW_CODEX_RUN
```

The HP command is a research Node CLI, not a published launcher. It emits native
shaped events, full journal, prompt records, history rows and a dated probe ledger.
It permits twenty client requests, 2,048 output tokens per response, a 180-second
deadline and a USD 0.10 usage review threshold. Native exec has one user turn and a
180-second harness deadline; its internal tool/response policy remains native.
These are probe bounds, not runtime defaults. No harness retries occur.

From the repository root, write/read the shared schema and run independent checks:

```sh
uv run --frozen python experiments/spikes/039-hp-agent-runtime/write_history.py \
  ~/history/evals/NEW_HP_RUN/history-rows.json ~/history/evals/NEW_HP_RUN/history.duckdb
uv run --frozen pdum-history ingest codex \
  --home ~/history/evals/NEW_CODEX_RUN/profile \
  --db ~/history/evals/NEW_CODEX_RUN/history.duckdb --window-days 0
uv run --frozen python experiments/spikes/045-hp-behavior/snapshot-result.py ~/history/evals/NEW_HP_RUN
uv run --frozen python experiments/spikes/045-hp-behavior/snapshot-result.py ~/history/evals/NEW_CODEX_RUN
uv run --frozen python experiments/evals/bin/report.py NEW_HP_RUN
uv run --frozen python experiments/evals/bin/report.py NEW_CODEX_RUN
```

The snapshot command uses `git diff --no-index`; it creates no Git worktree,
branch, index changes or commit. The existing larger launcher-client coding
battery was not run, and its historical baseline files were not rewritten.

## Model-selected application delegation

`application.ts` supplies real dashboard tools `read_rows` and `annotate_total`
plus the prototype child lifecycle tools. The parent receives an explicit
instruction to delegate once. The **model** chooses the `spawn_agent` call and
child message, the child model calls `read_rows`, and the parent calls `wait` and
`annotate_total`. The harness never creates the child on its behalf.

The rows contain 9, 12 and 20 units. Both Node and Chrome recorded two completed
threads, four tool calls and the correct annotation **41**, with the parent's
identity as author and the child's ID as calculation provenance. Both used six
Responses calls at reasoning `none`. Assertions inspect actual tool execution,
lineage and application state, not just a final text claim.

From `experiments/`:

```sh
node --env-file=../.env --import tsx spikes/045-hp-behavior/delegate.mjs \
  --out-dir ~/history/evals/NEW_DELEGATION_RUN
pnpm --filter @agent-spike/045-hp-behavior build
HP_PUBLIC_ROOT="$PWD/spikes/045-hp-behavior/dist" node --env-file=../.env \
  spikes/040-hp-integration/dev-server.mjs --live
```

Open the printed browser URL and select **Run live Luna delegation**. Both agent
loops run in the browser Worker. The development host only serves files and
forwards model WebSocket traffic with credentials. The actual AIUI prompt toolkit
constructs and verifies the six client requests; the inspector displays captured
prompt provenance. `window.hpDelegationEvidence` contains the report, journal,
tool calls and prompt captures for local saving. The page never receives an API
key. The browser has no local filesystem or shell tool.

The Node application run has twelve-request, 512-output-token and 120-second
bounds. The reused browser relay retains its 040 experiment bounds. Successful
Chrome 155 execution updated the visible total to `41 units`; the console showed
only a missing-favicon 404. The saved browser history also wrote the existing v5
schema: two threads, two turns, nine items, six responses and one spawn edge.

## Evidence and spend

Raw results are local under `~/history/evals/`:

| Run | Result | Estimated USD |
| --- | --- | ---: |
| `hp-mini-codex-20261018-r1` | Preserved missing-helper environment failure | 0.001825750 |
| `hp-mini-hp-20261018-r1` | All task gates; five tests | 0.002965455 |
| `hp-mini-codex-20261018-r2` | Complete installed 0.163.0; all gates; six tests | 0.003178000 |
| `hp-delegate-node-20261018-r1` | Model-selected child and real annotation | 0.000852245 |
| `hp-delegate-browser-20261018-r1` | Same task in real Chrome Worker | 0.000420035 |
| **045 subtotal** | | **0.009241485** |

The original browser relay evidence is also retained under ignored
`artifacts/040-hp-integration/browser-1792339517237/`; its ledger and raw messages
were copied into the browser run directory above. `run.json`, `metrics.json`,
`checks.txt`, `worktree.patch` and transcripts explain the coding results. HP's
`probe-ledger.json` agrees with the existing schema-based reporter to recorded
precision. Ordinary output usage already includes reasoning; it is not charged
twice. Current source helpers record reasoning explicitly and distinguish command
stdout bytes/exit codes from the JSON result wrapper.

Adding 043's USD 0.000423 makes this **second round USD 0.009664485 estimated**,
including the failed native setup attempt. The estimate uses dated Luna standard
rates from [the official model page](https://developers.openai.com/api/docs/models/gpt-6-luna).
Actual billing, count-only endpoint charges and coordinating/research-agent costs
are not available. These figures are not an invoice or a promise about unobserved
provider work. There were no additional paid calls for cleanup regression fixes.

## Remaining boundaries

The demonstration uses prototype subagent schemas, not native Codex's complete
multi-agent surface. It does not qualify arbitrary task delegation, long-running
background pages, durable processes, Electron, user questions/approvals or a
native Codex remote client against HP. Tool parity is selected and pipes-only;
MCP multimodal model delivery and real remote OAuth remain separate work. One
small coding task and one small dashboard task cannot establish general coding
quality. The next design should preserve these boundaries explicitly.
