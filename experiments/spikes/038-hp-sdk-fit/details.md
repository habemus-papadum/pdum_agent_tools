# SDK fit: implementation and evidence

## Decision

Use `openai` for the provider client, native types and transport. HP Agent should
own the small outer loop and its session/child lifecycles. Do not make the Agents
SDK runner the foundation for the current Codex-faithful prototype.

This is a version-specific fit decision, not a claim that the SDK cannot build
useful multi-agent applications. Its function tools, input filters, usage,
sessions, MCP integrations and compaction adapters are useful. However, supplying
a custom `Model` to repair steering and tool conversion would still leave us
owning those state machines, then translating them into the SDK's different item
model. That is little acceleration for the particular runtime we need.

## Source inspection

The exact installed packages are pinned in `experiments/pnpm-lock.yaml`:

| Package | Version |
| --- | --- |
| `openai` (direct dependency) | 7.38.0 |
| `@openai/agents`, `agents-core`, `agents-openai` | 0.20.0 |
| `openai` resolved by the umbrella `agents` package | 7.36.0 |
| `openai` resolved by `agents-openai` and injected by the probes | 7.38.0 |
| `zod` | 4.6.7 |
| `ws` | 8.22.0 |

Read these shipped source files under each package's installed directory; no
private module is imported by the probe:

- `agents-openai/dist/openaiResponsesModel.mjs`: public `OpenAIResponsesWSModel`
  ends its frame iterator at any terminal response event; incomplete is an error.
  Its private connection cannot be accessed through a public steer/send method.
- `agents-openai/dist/openaiResponsesConverter.mjs`: custom tool-call items reach
  the unknown-item fallback. Native API `apply_patch_call` is handled, but that
  is a different contract from Codex's custom `apply_patch` grammar tool.
- `agents-core/dist/tool.d.ts`: supported executable tools include JSON function,
  computer, shell and API apply-patch forms. Hosted-tool provider data can forward
  a custom declaration, but does not create a local executor for it.
- `agents-core/dist/run.d.ts`: `callModelInputFilter` controls instructions/input
  before each model request. This is a useful prompt-toolkit boundary.
- `agents-openai/dist/openaiProvider.d.ts`: `openAIClient`, `websocketBaseURL`
  and keepalive options are public. A per-instance socket factory is absent.
- `agents-openai/dist/responsesWebSocketConnection.mjs`: uses global WebSocket
  with custom headers. Browser credentials can be integrated with an application
  transport, but changing this global is not the per-instance boundary we want.
- `agents-openai/dist/memory/openaiResponsesCompactionSession.d.ts`:
  `runCompaction({force:true})`, an injected client, and caller-owned underlying
  session are public. Compaction clears/replaces model context in that session.
- `openai/resources/responses/ws.d.ts` and `ws-base.d.ts`: public `ResponsesWS`
  sends steering and exposes a raw event iterator. The Node adapter is isolated
  from browser-portable code; a host can supply another connection factory.

The [official SDK model/transport guidance](https://developers.openai.com/api/docs/guides/agents/models)
confirms the Responses WebSocket route is the text/tool loop, distinct from
Realtime voice sessions. The [WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode)
documents continuation and connection-local state. We do not treat a cached
response ID as a durable session.

## Credential-free experiments

`probe.ts` starts a real loopback WebSocket server and passes its URL to the real
SDK. No OpenAI credentials or provider calls are involved. The server scripts
specific messages to test the client's interpretation:

1. A JSON `exec_command` function call executes once and is returned on a second
   model request. Both requests appear in SDK usage; raw stream events remain
   available.
2. The provider receives the unchanged custom grammar declaration, but its
   `custom_tool_call` is not executed by the runner. A one-turn run ends with the
   expected max-turns error. This confirms the source-inspected conversion gap.
3. A server-injected accepted steer followed by incomplete/steered and a successor
   causes the SDK to throw at incomplete. This does not pretend the SDK can send
   a steer; it isolates how its consumer handles that server sequence.
4. An input filter changes the effective instructions and input on the wire.
5. Separate providers/runners execute two concurrent children with distinct
   histories. A shared cached model wrapper serializes its requests; separate
   providers avoid this, but neither arrangement supplies the application's
   persistent child registry or mailbox.

`compaction-probe.ts` uses the public `OpenAIResponsesCompactionSession` against a
local HTTP server. It sends the supplied history to `/v1/responses/compact`,
replaces two context items with one fixture compaction item, and returns endpoint
usage. The fixture's opaque text is deliberately not a valid provider compaction
artifact. This establishes storage/adapter behavior only.

`direct-probe.ts` uses the public `ResponsesWS` transport against loopback peers.
It checks accepted/committed steering, accepted/pending/committed tool continuation,
terminal token-limit handling while a steer is unresolved, disconnect after
acceptance, context replacement, and generator abandonment both with and without
abort. Unknown outcomes stay errors; they do not trigger replay. Next-turn restart
after abandonment uses a fresh connection.

## The experimental connector

`connector.ts` exports native input records and a stream with text, output items,
tool calls, usage, raw events, and steering state. A run has a `steer()` operation
and consumes an `AbortSignal`. Dispatching a steer does not claim provider
acceptance; only stream events establish acceptance and later commitment.

`DirectResponsesConnector` is a model-round adapter, not an agent scheduler. It
retains one connection and continuation prefix per thread. Native tool calls are
returned to the runtime; the runtime executes them and appends the correct native
result. The next model round sends only new context items with the previous
response ID. This preserves accepted steering waiting for tool results.

Committed steering yields `inputItem`; callers append it to context exactly once.
Pending text remains separately visible in the transcript. Replacing context
starts a new connection and full-context request, and is rejected while steering
outcome is still pending. A fork uses another thread ID and its saved context.
The prototype uses separate sockets for children; multiplexed lanes are deferred.
Requests ask for encrypted reasoning content so a saved context can retain native
opaque reasoning when the model supplies it. The live probes used reasoning
`none`; they do not qualify a reasoning-heavy fork or compaction checkpoint.

The injected factory owns authenticated transport construction. The Node factory
uses public `ResponsesWS`, disables reconnect, and registers its stream before
sending. Neither the connector nor browser runtime needs Keychain or federation
knowledge. `direct.ts` contains no Node imports. Its default request options impose
no probe limits; the paid harness supplies its own output/time bounds.

This code is intentionally small. It does not implement durable reconnect,
application-owned approvals, provider-hosted multi-agent execution, scheduler
policy, or a production session database. The consumer must preserve native items,
supply a bounded probe signal when testing, and close its connector when done.

## Live evidence and spend ledger

All live requests used exact `gpt-6-luna`, default service tier, and short input.
No fallback model, tools with external side effects, automatic retries, or
credential printing were used. The initial allocation was five generated
responses, 256 maximum output tokens each, 30 seconds per scenario, and USD 0.10.
The coordinator authorized a diagnosed parameter correction and then a separate
two-response steering follow-up (revised cumulative bound eight). Six responses
were generated. These are experiment limits, not runtime defaults.

| Run on 18 October 2026 (UTC) | Result | Input | Output | Estimated USD |
| --- | --- | ---: | ---: | ---: |
| 15:12:43 parameter preflight | Three requests rejected: `minimal` reasoning unsupported. No usage returned. | — | — | No observed usage; billing unknown |
| 15:14:19 ordinary SDK | `SDK_OK` | 18 | 6 | 0.0000048 |
| Same run, steering | Accepted, then token limit; adapter closed before commitment was observed. | 34 | 256 | 0.0001314 |
| Same run, custom grammar tool | Empty patch returned as native custom call. | 127 | 18 | 0.0000217 |
| Same run, custom tool result | Native result continued to `CUSTOM_OK`. | 77 | 6 | 0.0000107 |
| 15:17:03 shorter steering parent | Three short Moon facts; accepted steer did not retract them. | 32 | 32 | 0.0000192 |
| Same run, automatic successor | Committed steering, `STEER_OK`. | 80 | 7 | 0.0000115 |
| **Generated-response total** | **Six responses** | **368** | **325** | **0.0001993** |

Cached-input and cache-write counts were zero. Rates checked on 18 October 2026:
USD 0.10 input, 0.01 cached input, 0.125 cache-write input, and 0.50 output per
million tokens, for short-context default service. See the
[Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna).
This is an API-equivalent estimate from reported usage. **Actual billing is
unknown**, including whether rejected requests had any charge.

The first run accidentally used reasoning `minimal`; the provider rejection
identified the valid choices. Corrected tests use `none`. The first steering
prompt was too long for the intended 256-token bound. Fixing its premature
incomplete handling and using a shorter prompt led to observed commitment. We
retain these failures rather than counting only successful attempts.

Local artifacts under `experiments/artifacts/038-hp-sdk-fit/` include
`local-summary.json`, `direct-local-summary.json`, `compaction-local-summary.json`,
`live-parameter-rejection-summary.json`, `live-summary.json`, and
`live-steering-summary.json`; adjacent event JSONL files contain raw provider data
and remain ignored. Subsequent invocations also preserve timestamped copies.

## What remains uncertain

Live tests cover Node transport, ordinary SDK generation, direct steering and a
small freeform tool exchange. Local tests establish SDK behavior on injected
sequences; they do not prove production recovery, compaction quality, or arbitrary
Codex tool fidelity. The browser connection and combined worker/runtime path are
qualified by the other spikes, not this package. Child cancellation, mailboxes,
lineage, and compaction evaluation still belong to the outer runtime and battery.
