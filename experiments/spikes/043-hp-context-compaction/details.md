# Context compaction: evidence and implementation notes

## What this resolves

The previous round qualified manual context replacement and a public SDK
compaction adapter against a scripted server. This round called the real explicit
compaction endpoint and continued from its returned context. It also tested a
reasoning-enabled fork on a fresh connection, using `store:false` and complete
native items rather than depending on the original connection's response cache.

The implementation lives only in this spike. It imports the existing public
experimental interfaces from 038/039 without editing those packages. No native
Codex recovery internals, SDK private state or opaque reasoning content were
reverse-engineered.

## Public API and source observations

The pinned `openai` 7.38.0 package exposes `client.responses.compact` in
`resources/responses/responses.d.ts`. Its request accepts model, input,
instructions, previous-response ID, cache settings and service tier. Luna is
included in the model type. There is **no `max_output_tokens` or reasoning-effort
parameter** on this endpoint. Ordinary response settings should not be assumed
to constrain a separate compaction call.

The [standalone compaction contract](https://developers.openai.com/api/docs/guides/compaction)
returns the canonical next context window. We keep every returned item, in order;
extracting only `type:compaction` would drop retained messages. The live response
contained exactly one retained user message and one opaque compaction item.

The [compact reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/compact)
includes usage for the compression pass. It also describes reuse of completed
reasoning items. Our existing connector records `response.output_item.done`, not
the potentially unfinished item from `response.output_item.added`.

The adapter accepts the host's authenticated OpenAI client. It has no environment,
filesystem, Keychain or federation access. Its only OpenAI import is a TypeScript
type; the browser bundle's input list contains only `src/compaction.ts`.

## Adapter behavior

`compactIdleThread(runtime, threadId, client, options)`:

1. Reads an idle thread and snapshots its full native context and transcript state.
2. Calls `responses.compact` with that context, model, effective instructions and
   default service, disabling automatic retries for this operation.
3. Captures endpoint-specific usage, including cached/cache-write and reasoning
   fields, plus the provider response and both context versions.
4. Rechecks the thread. If another turn or context edit happened, returns
   `status:discarded` and the usage without replacing context.
5. Otherwise calls the existing `replaceContext` method with the full output
   window. The existing runtime adds a context checkpoint; conversation turns and
   visible tool results remain intact.

The race check is optimistic and local. It does not add a single-controller lock.
A production implementation would give context revisions explicit identities and
persist the compaction outcome in the observation journal. This spike returns the
outcome to its caller and saves it in local artifacts. It does not insert fake
conversation usage into `runtime.usages`: the compact call belongs to its own
endpoint accounting record.

The direct connector notices a changed context prefix on the next turn and opens
a fresh connection with full input. A fork receives a new thread ID and another
connection. Neither operation re-executes the fixture tool. Copied context is not
a new billing event; only subsequent provider requests add usage.

`inspectContext` reports item counts, presence of opaque items and serialized
bytes. It returns no computed token total. API token-count observations are
recorded separately with the exact scope used for each call.

## Credential-free tests

Three tests use the official OpenAI HTTP client against a real local server and
the 039 runtime's explicitly scripted connector:

- Preserve a retained message and opaque compaction fixture as a complete window;
  leave the transcript unchanged; retain a checkpoint in offline replay and a fork;
  return compaction usage separately.
- Start a new turn while the HTTP request is held. After it completes, discard the
  stale compacted context but retain its usage.
- Reject compaction of an active thread before sending anything; a provider 500
  is not retried and leaves context unchanged.

The encrypted fixture is not provider-valid; it establishes local state behavior.
Typecheck, all three tests and the browser bundle passed. The browser build does
not count as a browser network qualification.

## Live task and connections

All ordinary responses used exact `gpt-6-luna`, reasoning `low`, standard service,
`store:false`, `include:["reasoning.encrypted_content"]`, and a small structured
JSON output. The tool result, not the user prompt, supplied the inventory data.
The fixture returned project `CEDAR-7`, delivered as the smallest positive integer
with remainders 3 modulo 7, 5 modulo 11 and 6 modulo 13, returned 19, and packed 23.
The smallest delivered value is 500; availability is therefore 458.

The successful run used four connections:

| Connection | Input mode | Result |
| --- | --- | --- |
| 1 | New task, then tool result with previous-response ID | One fixture tool call; model solved the constraints and returned 458. The solution response reported 131 reasoning tokens and a completed encrypted reasoning item. |
| 2 | Full native pre-compaction context, no previous-response ID | Fork returned 458. Its request included the reasoning item with encrypted content. |
| 3 | Complete compacted window plus new user correction, no previous-response ID | Packing five more units produced 453. |
| 4 | Compacted window plus later reasoning/message items and branch update, no previous-response ID | Delivering 11 more units produced 464; the parent's snapshot was unchanged. |

The model-generated encrypted item was preserved as opaque data, not inspected or
decrypted. Successful continuation demonstrates acceptance and retention for this
task; it cannot prove that every prior detail survives compaction. Replay of the
runtime's journal matched its saved snapshots, including the unmodified original
transcript, tool result, fork lineage and compaction checkpoint.

Before compaction, the model context had five items: user message, function call,
function result, reasoning item and assistant message. The returned window had
two: retained user message and compaction item. Serialized size changed from
3,575 to 2,887 bytes. API counts using the same instructions and no tool definitions
changed from 344 to 205 tokens (139 fewer, approximately 40.4%). These figures
measure that supplied window, not a universal current-context percentage or the
compaction endpoint's billing input. The compact call itself reported 362 input
tokens, which includes its own processing context.

## A useful token-counting correction

The initial generation preflight sent items, instructions and tools to
`responses.inputTokens.count`, but omitted `text.format`. Each observed generation
had 28 more input tokens than that preflight count. The missing component was the
structured-output schema. One count-only follow-up replayed the first request's
full supported shape, including `text` and `reasoning`: **178 counted, 178 observed**,
versus the earlier incomplete count of 150. The harness now includes those fields.

The before/after compaction comparison deliberately used the same instructions
and no tool or output schemas on both calls, so its 344/205 comparison remains
valid. Do not add arbitrary overhead or convert JSON bytes to compensate for a
missing request component. Use the actual request shape, as described by the
[token-counting API](https://developers.openai.com/api/docs/guides/token-counting).

## Bounds, failures and spend

The initial live run at 15:54 UTC used plain inventory arithmetic: delivered 137,
returned 19, packed 23. Both responses completed correctly with 95 available but
reported zero reasoning tokens and no reasoning item. The harness initially
stopped on an overstrong expectation that `low` always produces one. That was a
probe assumption, not a provider failure.

After coordinator review, the task was changed once to the modular-constraint
fixture, keeping the model and effort unchanged. The revised harness continued
through compaction whether or not a reasoning item appeared. It did appear on
that run. No automatic retries, model substitutions or repeated searches for
reasoning artifacts followed.

The total authorization remained USD 0.10, with a revised seven ordinary
responses and one compaction. Ordinary calls were limited to 1,024 output tokens,
10,000 measured input tokens, and 60 seconds per call. Compaction used one short
window. Because the endpoint exposes no output cap, its planning allowance used
the model's documented 128,000 maximum output tokens: approximately USD 0.064 plus
short input, not an endpoint-enforced limit. We would stop and reassess before a
second compact call if the result or usage were uncertain. None was needed.

The old incomplete schema preflights were below 500 tokens; the subsequent actual
usage checks were also below 500. Corrected future preflights include output
schema overhead. The successful run made seven input-count calls; the initial run
made two, and the count-only correction made one. Those ten calls generated no
responses and returned no model usage; actual billing is not inferred from that.

Rates checked 18 October 2026 from the [Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna):
USD 0.10 uncached input, 0.01 cached input, 0.125 cache writes and 0.50 output per
million tokens, short-context standard service. All cached and cache-write counts
were zero. Output includes reasoning tokens; they are not charged again below.

| Run / operation | Input | Output | Reasoning included in output | Estimated USD |
| --- | ---: | ---: | ---: | ---: |
| Initial simple task, tool call | 157 | 14 | 0 | 0.0000227 |
| Initial simple task, answer | 203 | 19 | 0 | 0.0000298 |
| Constraint task, tool call | 178 | 14 | 0 | 0.0000248 |
| Constraint task, solution | 264 | 152 | 131 | 0.0001024 |
| Pre-compaction fork | 431 | 19 | 0 | 0.0000526 |
| Explicit compaction | 362 | 96 | 0 | 0.0000842 |
| Parent continuation | 303 | 44 | 23 | 0.0000523 |
| Compacted-context fork | 377 | 33 | 12 | 0.0000542 |
| **Total** | **2,275** | **391** | **166** | **0.0004230** |

**Actual billing is unknown.** These estimates derive from reported provider
usage and dated rates, not a billing statement. SDK version 7.38.0, Node 26.10.0,
pnpm 11.9.0, macOS arm64. Raw evidence is ignored under:

- `experiments/artifacts/043-hp-context-compaction/1792338890434/`: initial run.
- `experiments/artifacts/043-hp-context-compaction/1792338999453/`: successful run
  and `count-validation.json` follow-up.

Each directory contains the summary, raw request/response data, full journal and
saved snapshots. Do not publish those artifacts. The report above contains the
reviewable aggregate evidence.

## Architecture implications and remaining limits

Keep three distinct records: complete transcript, active model context, and
context checkpoints with provider provenance and usage. A user can inspect the
old tool output after compaction even though it is absent from active model input.
A fork copies the intended context checkpoint and later items, while preserving
its lineage; it does not replay prior tool side effects.

Explicit compaction fits the intended steerable runtime because it runs between
turns. This spike does not combine active steering with compaction, qualify
cross-model encrypted-state reuse, measure long-session information loss, or
provide durable recovery. A future evaluation should test retention over longer
real tasks and mixed tool histories before choosing automatic compaction triggers.
