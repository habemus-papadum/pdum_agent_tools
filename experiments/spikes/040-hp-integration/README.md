# HP Agent: combined Node and browser demonstration

**Observed 18 October 2026:** Node and an actual Chrome Worker each completed the
same client flow against live `gpt-6-luna`: one host tool call, accepted/pending/
committed steering, an independent child with two turns, an idle-boundary fork,
and offline history replay. Each produced three threads, five visible turns
(including one inherited turn), fourteen items and five provider responses.

The runtime is [039](../039-hp-agent-runtime/README.md), its model connector is
[038](../038-hp-sdk-fit/README.md), and prompt preparation uses
[041](../041-hp-codex-fidelity/README.md). This integration adds no production
library. Read the [combined findings](../../../docs/hp-agent-findings.md) first.

## What is actually running

The browser Worker owns the loop, tool execution, child runtimes, histories and
model connections. `dev-server.mjs` serves the static bundle and forwards
WebSocket text frames with a development credential attached upstream. It never
interprets prompts to run an agent. Its validation/count/time bounds are specific
to this experiment; they are not proposed production runtime limits.

The host supplies authenticated connection construction. Production integration
can reuse the existing AIUI credential/client factories. No new credential
management system or browser authentication feasibility claim is introduced here.

Both live paths use the full 18,037-character Luna instruction template imported
from the pinned Codex source. Every client `response.create` is constructed through
real `aiui-prompts` records and the versioned public-Responses adapter. The sent
JSON is captured and verified against its saved semantic operation. Five sends
verified in Node and five in Chrome. Automatic provider steering successors are
separate responses, not additional client sends.

The browser presents the actual `aiui-prompts-inspector/model` headless controller
with plain HTML controls. It shows canonical text, provenance, semantic records
and captured-payload equality. It does not recreate the toolkit's full Solid UI.
The native prompt is embedded only into ignored build output. Browser fixture
records are labeled **prepared-not-sent**, so a successful inspection does not
pretend a model request occurred.

## Reproduce without model calls

From `experiments/`, with the pinned [Codex checkout](../../vendor/README.md) and
the local AIUI checkout available:

```sh
pnpm install --frozen-lockfile
AIUI_PROMPTS_CHECKOUT=/path/to/pdum_aiui pnpm --filter @agent-spike/040-hp-integration test
pnpm --filter @agent-spike/040-hp-integration native
pnpm --filter @agent-spike/040-hp-integration serve
```

The server prints a fresh port. Open it and select **Run fixture**. The build test
also exercises the actual bundled Worker module under Node, a scripted socket
boundary and the actual headless inspector. The `native` command launches the
clean Codex build in a disposable unauthenticated home, materializes a thread
using a harmless local `printf` command, then reads, lists and forks it. It makes
no model calls and removes its temporary home after process exit.

## Explicit live checks

Supply `OPENAI_API_KEY` through the host environment. If using the existing ignored
repository `.env`, from `experiments/`:

```sh
node --env-file=../.env --import tsx spikes/040-hp-integration/live-node.mjs --live
node --env-file=../.env spikes/040-hp-integration/dev-server.mjs --live
```

Open the printed server URL and select **Run live Luna demo**. Alternatively call
`window.runHPDemo({live:true,url:'ws://localhost:PORT/responses'})` in that page.
`window.hpEvidence` retains captures, inspection results and the saved journal;
the UI terminates its Worker after collecting the evidence. No API key is included
in the browser page, journal or prompt records.

Each harness allows at most twelve client creates, twenty-four observed responses,
512 output tokens per request, a 120-second model-work deadline and an estimated
USD 0.10 probe allowance. The completed flows used five responses each. API
timeouts/disconnects can leave an unknown outcome; there is no automatic replay.
The development server stops at its deadline or SIGINT/SIGTERM. Raw captures stay
under ignored `experiments/artifacts/040-hp-integration/`.

## Offline schema and evaluation compatibility

`export-saved.mjs DIRECTORY` reprojects a journal using current history code
without creating a model client. For browser evidence, first save
`hpEvidence.recording.journal` as `DIRECTORY/journal.json`. Then:

```sh
# From experiments/:
node --import tsx spikes/040-hp-integration/export-saved.mjs artifacts/040-hp-integration/RUN
# From the repository root, using the production schema's environment:
uv run --frozen python experiments/spikes/039-hp-agent-runtime/write_history.py \
  experiments/artifacts/040-hp-integration/RUN/history-rows.json \
  experiments/artifacts/040-hp-integration/RUN/history.duckdb
uv run --frozen python experiments/spikes/040-hp-integration/inspect-history.py \
  experiments/artifacts/040-hp-integration/RUN \
  experiments/artifacts/040-hp-integration/RUN/history.duckdb
```

The schema writer refuses an existing destination. The inspection command copies
the database/journal into a new `~/history/evals/hp-spike-RUN/` and invokes the
existing eval `measure()` function. It does **not** run or grade the coding task.
Both live exports wrote five real response-usage rows, with no duplicated response
IDs and one fork and spawn edge each. The Chrome journal's 62 native notifications
also passed the pinned native JSON schemas.

Three existing evaluator assumptions need correction before quality comparisons:

- Its Luna tuple is 100 times the dated short-context rates used here. It reports
  USD 0.06 for the Node trace versus this ledger's USD 0.000641985 (rounded values).
- It counts 32 output bytes across original and inherited tool records; own work
  produced 16 bytes. Tool-call count already excludes inherited records.
- It chooses the main thread by response count. A tie selected the child in the
  browser trace. Root identity should be explicit for root-context measurements.

These are reported findings; this spike does not alter the existing evaluator or
its recorded baselines. The multi-minute coding battery was not run.

## Evidence and spend

| Check | Artifact under `artifacts/040-hp-integration/` | Observed result |
| --- | --- | --- |
| Native app-server, no credentials | `native-1792336104218/result.json` | Start, shell turn, read, list and fork; zero provider responses. |
| Node live | `node-1792336732262/result.json` | Five responses, five verified prompt sends; estimate USD 0.000641985. |
| Chrome live | `browser-1792336976539/browser-evidence.json`, `ledger.json` | Five responses, five verified sends, actual inspector equality; estimate USD 0.000224225. |
| First browser attempt | `browser-1792336919633/` | Relay forwarded text as binary; connection closed before any response/usage. Fixed text framing and reran once. Billing unknown. |

Node usage: 18,030 input tokens, including 14,286 cache reads and 3,729 cache
writes, plus 63 output tokens. Chrome: 18,033 input, including 17,935 cache reads
and 83 cache writes, plus 66 output. All reported default service and short
context. Rates dated 18 October 2026, USD per million: uncached input 0.10,
cached input 0.01, cache writes 0.125, output 0.50.
[Pricing source](https://developers.openai.com/api/docs/models/gpt-6-luna).

Combined with 038's six responses, the round observed **sixteen generated
responses, estimated USD 0.00106551**. This is API-equivalent probe usage, not a
confirmed bill. Rejected requests returned no usage. The environment does not
expose billing for the coordinating/research agents; that work is unpriced here.

Versions: Chrome 155.0.0.0 on macOS, Node 26.10.0, pnpm 11.9.0, OpenAI 7.38.0,
Agents SDK 0.20.0, AIUI `217f6d731c07e36586349aaf6feb2310d1d2b9bf` (prompts package
clean; unrelated pencil changes), Codex `6c372fbef45f730b6d8aa727b0ec8332365588db`
clean. The browser console had only a missing-favicon 404 during the successful run.

## Limits

This is a functional control/recording experiment, not a Codex-quality evaluation.
The host echo tool is real but not a filesystem tool suite. The harness starts and
messages children; model-selected delegation is not live-qualified. Forks are
idle-boundary conversation copies, and use reasoning `none`; reasoning-heavy
forks and real compaction are unqualified. The context checkpoint is explicit
replacement, not summarization. Skills, MCP execution, durable storage, background
tab survival, Electron, native approvals and broad protocol compatibility need
further work. No vanilla Codex remote CLI compatibility is claimed for HP Agent.
