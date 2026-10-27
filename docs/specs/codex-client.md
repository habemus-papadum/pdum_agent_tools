# Codex client API design

**26 October system proposal:** the [library map](../plans/agent-orchestrator/system-design.md)
preserves this provider-native API baseline while moving cross-provider analysis
to `agent-history/analysis`, management to `orchestrator-client`, and reused
contracts/mechanics to a small `agent-core`. Its [staged plan](../plans/agent-orchestrator/system/implementation.md)
orders extraction against an actual application; type generation must use the
selected current binary/source pin. The historical pin and examples below are
design evidence, not an instruction to claim support for every installed server.

**Status: proposed for review, 14 October 2026.** No client package or API below
is implemented. The user requested this design and its
[implementation plan](../plans/codex-client.md) before authorizing construction.
Examples describe the proposed interface; they are not runnable examples yet.
The [025–034 findings](../codex-client-findings.md) are the evidence baseline.

**18 October update:** reviewed as a baseline. The [HP Agent findings](../hp-agent-findings.md)
recommend MessagePort support, explicit runtime capability differences and reuse
of the existing history package before construction. These refinements remain
proposed; no production Codex client is implemented.
The [second HP round](../hp-agent-behavior.md) supplies further implementation
evidence for those boundaries, including coding tasks and real compaction.
The [power-user parity pass](../hp-agent-parity.md) identifies the advanced native
contracts to preserve and qualifies selected dynamic-control behavior in HP.
The [parallel work findings](../hp-agent-work.md) add evidence for independent
job observation/cancellation and distinguish native methods from HP job extensions.
The [AIUI contract](hp-aiui-integration.md) permits upstream changes without
making the generic client depend on Solid or AIUI.
The [agent orchestrator component map](../plans/agent-orchestrator/index.md) is
the proposed concrete application consumer. Its shared views preserve native
capabilities; its host/profile management layer does not redefine this protocol.
That layer is now the proposed [unified host coordinator](../plans/agent-orchestrator/components/21-host-coordinator.md).
Its [recovery sketch](../plans/agent-orchestrator/failure-recovery.md) separates
client rejoin from process rediscovery and a new history-based launch.

## Recommendation and decisions to review

Build one framework-independent TypeScript package for browser and Node clients.
Use upstream-generated protocol types, a small bidirectional connection, explicit
history/live operations, and reusable state/analysis functions. Keep the Python
launcher responsible for profiles, authentication setup and app-server lifetime.

| Decision | Recommended starting point |
| --- | --- |
| Package and layout | One proposed `@habemus-papadum/codex-client` package in the existing `typescript/` pnpm workspace. Name/scope are provisional; no npm publication is authorized. |
| API depth | Full generated protocol access immediately; conveniences share that connection. Enable experimental API negotiation by default, with an explicit opt-out. |
| History versus live work | Reading history never calls resume. Joining explicitly calls native resume, which can activate a goal. |
| Multiple clients | Support multiple listeners/responders. Expose native outcomes and uncertain submissions; no controller lease or automatic turn replay. |
| Shared analysis | Pure TypeScript functions run in browsers, Node and offline readers. Python emits a compatible observation format; it does not import TypeScript functions. |
| First review milestone | Two browser clients share a conversation, either can answer a question, and an offline reader inspects the saved recording with no server or credentials. |

The existing [trusted-operation principles](../design-principles.md) apply.
Connections have no arbitrary expiry or mandatory grants. Native configuration
and host policy remain authoritative; the client does not introduce another
sandbox, approval or account-renewal policy.

## Ownership and upstream reuse

The cross-component [runtime contracts](../runtime-contracts.md) are the
canonical reference for lifecycle constraints and their evidence. This
specification owns the API; reference relevant RC entries when implementing
attachment, resume, background work and recovery instead of duplicating their
research narratives here.

| Component | Owns |
| --- | --- |
| Python launcher | Profile configuration/authentication setup, native process, relay endpoint, status, optional recording/MITM and cleanup. |
| Native Codex app-server | Conversations, tool execution, account state, native persistence and RPC behavior. |
| TypeScript client | Its connection, pending RPCs, locally materialized views, explicit user actions and optional analysis. |
| Application | UI, endpoint/profile selection, pet/swarm identity, when to join or submit work, and desired recording destinations. |

The client accepts an already-provided endpoint. Importing it or opening a history
view never launches a process. The current Codex management HTTP adapter exposes
`GET /status`, `POST /capture` and `POST /stop` over an existing owner. It does not
provide a profile catalogue or launch endpoint. Multi-host/profile discovery is
an application concern until a separate management extension is designed.

The inspected upstream TypeScript SDK uses local process execution. Official
OpenAI documentation recommends app-server for rich custom clients and provides
version-specific TypeScript/schema generation. Reuse those exports and their
native names; refer to the official Python app-server client where useful for
connection mechanics. No second agent loop is needed.
[SDK guidance](https://learn.chatgpt.com/docs/codex-sdk),
[protocol generation](https://learn.chatgpt.com/docs/app-server).

Proposed exports from one package:

| Import | Contents | Runtime requirement |
| --- | --- | --- |
| Package root | `CodexClient`, WebSocket transport, common live/history/file/process operations | Browser or Node |
| `/protocol` | Generated native types and method/result registry, generation provenance | Type-only imports where possible |
| `/analysis` | Pure reducers, coverage/identity types, history and observation adapters, price calculations | No network, filesystem, native binary or automatic clock reads |
| `/node` | File-based recording/replay adapters; later optional Unix transport | Node only |
| `/launcher` | Thin optional client for the three existing launcher HTTP operations | Fetch-compatible runtime |

Keep browser imports free of Node built-ins. Start with ESM and declarations;
CommonJS and UI-framework bindings are later needs, not initial dependencies.
TCP WebSocket through the existing relay is the first transport in both runtimes.
The transport interface leaves room for Unix/stdio adapters without requiring
Node process ownership in the initial package.

## Protocol and compatibility contract

Generate the complete experimental TypeScript surface from the clean
`6c372fbef45f730b6d8aa727b0ec8332365588db` build, and retain stable-versus-experimental
metadata. That is the initial type baseline, not a claim every connected server
supports it. Test the installed 0.162.1 release and that clean build separately.
The latter reports `0.0.0`; record its hash/revision as well as its version string.

Check generated types into the future package with executable/schema hashes,
source revision, generation commands and required upstream attribution. Generate
method-to-parameter/result mappings, including server-request result types, from
the matching pinned protocol declarations where exports do not contain that
association. Assert complete, unique mappings; fail regeneration on unresolved
types instead of guessing a response type. The older 007 inventory mixed an
installed schema with a newer source pin and is background evidence, not the
production generator's source of truth.

`experimentalApi` defaults to true in this toolkit and remains configurable.
Expose three distinct facts: what the bundled types describe, what the connection
negotiated, and what the selected server has actually accepted. There is no
assumed universal capability-discovery RPC. Unsupported methods retain their
native errors; a tested compatibility table can explain them. Do not probe
mutating methods just to discover support, or block unfamiliar servers solely
because their version is absent from the table.

Preserve unknown fields and notifications, native errors and original payloads.
Known method names have typed requests/results; `requestRaw` and raw request/event
access allow newer methods. Minimal envelope validation protects correlation;
an unknown item variant becomes an opaque item with coverage information instead
of disappearing. Malformed JSON/envelopes produce diagnostics and an explicit
connection failure when routing cannot continue reliably.

## Connection and low-level API

```ts
import { CodexClient, webSocketTransport } from "@habemus-papadum/codex-client";

const client = await CodexClient.connect({
  transport: webSocketTransport(endpoint),
  clientInfo: { name: "pet-console", version: "0.1.0" },
  experimentalApi: true,
  scope: { profileKey: "host-a/research", serverRunId: launcherStatus.run_id },
});

const page = await client.rpc.request("thread/list", { limit: 20 });
const removeListener = client.events.subscribe(event => inspect(event));

// A newer method can be called before this package has named types for it.
const extensionResult = await client.rpc.requestRaw(extensionMethod, extensionParams);

removeListener();
await client.close();
```

`connect` installs routing before sending `initialize`, then sends `initialized`
after success. It resolves when the protocol connection is ready, not when an
account is authenticated or a model is available. A failed handshake closes the
owned transport. Initialization has a configurable finite timeout; ready
connections and long operations have no arbitrary idle expiry.

`scope` is optional application-provided correlation, not a server-authentication
claim. `profileKey` identifies a host/profile namespace; `serverRunId` identifies
one native process lifetime when supplied by its owner. Without known continuity,
new connections get a new observation scope and cross-reconnect correlation is
marked unknown. Equal version strings or callback IDs do not prove the server
instance is the same.

The connection exposes:

- `rpc.request(method, params, { signal?, timeoutMs? })`, typed from the registry.
- `rpc.notify(method, params)` for native client notifications, and explicit raw
  equivalents for extensions. Client-generated request IDs are connection-local;
  string and numeric native IDs remain distinct.
- `events.subscribe(listener)` for notifications and diagnostics, and
  `requests.subscribe(listener)` for pending server requests. Both return local
  unsubscribe functions; callbacks are delivered through independent queues.
- `observations.subscribe(listener)` for original outgoing/incoming messages and
  connection/loss records, including RPC replies. Recorders and live analysis
  consume this surface rather than trying to reconstruct traffic from UI events.
- `snapshot()` for connection/initialization status and observation backlog/errors.
  `close()` ends this connection and settles its outstanding local operations.

Protocol routing does not await application handlers, recording or exporters.
Slow or failed consumers have visible backlog/error/loss state. Add no initial
queue admission limits or payload truncation. This is cooperative isolation:
synchronous CPU-heavy JavaScript can still block its event loop. Applications can
place expensive analysis in a Web Worker or Node worker explicitly.

### Requests, timeouts and reconnection

| Result | Meaning |
| --- | --- |
| Native RPC result/error | The server answered this request; preserve its result or code/message/data. |
| Local validation or cancellation before send | No request was dispatched. |
| Timeout, cancellation or disconnect after possible send | The operation may have taken effect. Return an error carrying method, request ID, scope and `outcome: "unknown"`. |
| Native turn completion | Separate from the earlier `turn/start` acknowledgement. |

`AbortSignal` cancels the local wait. It does not imply a server-side cancellation,
turn interruption or process kill. Call the specific native interrupt/kill method
when that is intended. Late replies are still observable and can reconcile a
previously unknown result; they cannot resolve an already-rejected promise.

The initial client performs no automatic RPC retries, reconnects or resubscriptions.
Applications open a new connection explicitly. Read-only queries may be repeated;
joining/resuming and mutation retries require operation-specific decisions.
`clientUserMessageId` is correlation data, not an idempotency guarantee. A later
reconnect helper must retain these rules rather than silently replaying commands.

Lifecycle operations have deliberately different effects:

| Operation | Intended effect |
| --- | --- |
| Remove a UI subscription | Stop local rendering/inspection only. |
| `session.leave()` | Unsubscribe this connection from the thread. |
| `client.close()` | End this client's connection; other clients and the native server remain owned elsewhere. Agent work can continue; connection-owned standalone processes lose their handles. |
| `session.interrupt({ turnId })` | Request interruption of identified agent work; follow native completion state. |
| `process.kill()` | Ask native Codex to stop this connection's standalone process. |
| Launcher `stop` | Stop the owned app-server and affect all its clients, through the separate management API. |

The SDK adds no per-thread controller lock or hidden serialization of competing
turn submissions. Native concurrency behavior and identity guards remain visible.

## History and administration

Proposed convenience methods mirror native operations and return native response
shapes. Derived coverage and presentation state live in separate views, rather
than adding invented fields to native objects.

| API group | Initial operations |
| --- | --- |
| `client.threads` | `list`, `loaded`, `search`, `rename`, `archive`, `unarchive`, `delete` |
| `client.history` | `read`, `turns`, `items`, `searchOccurrences`; later `readItems` where supported |
| `client.annotations` | `add`, `list`, `remove`, `owners`, mapping native attachment methods |
| Native `rpc` | Projects, sections, read-state updates, account/config/model discovery and every other generated method |

History calls never implicitly resume, fork, hydrate through resume, or subscribe.
A history failure is not repaired by waking the thread. `turns`/`items` return
native page cursors unchanged; callers choose page size, direction and full or
summary items. No convenience loads an entire session without an explicit request.

```ts
const page = await client.threads.list({ limit: 20, sourceKinds: ["exec"] });
const threadId = page.data[0].id; // Application handles an empty page.
const saved = await client.history.read({ threadId, includeTurns: true });
renderSavedHistory(saved.thread); // Still no live subscription or turn.

await client.annotations.add({
  threadId,
  attachmentType: "pet-console.tag",
  identityKey: "needs-review",
  payload: { label: "Needs review" },
});
```

Keep native thread IDs plus the application profile key. List results can omit
empty threads, filter out source kinds and duplicate IDs after revert. The raw
page is preserved; the catalogue view deduplicates identities and refreshes
selected details without inventing total completeness. Global search and
per-thread search expose their different scope.

Attachments support application tags/notes. Adding an existing type/key preserves
its old payload. Offer explicit add/remove initially, not a misleading atomic
`upsert`; a future replace convenience must expose its race/non-atomic semantics.
Use native read-state revision checks when supported. Do not silently fall back
to another metadata store or override conflicts from another client.

Account/config operations remain available through native RPC. Account changes
can affect all clients of that server. Profile login remains available on the
host; browser account workflows may use native account RPCs when an application
chooses them. The client does not read the host Keychain or own credential renewal.

## Live sessions and turns

A `LiveSession` is a local view/control handle for one native thread, not another
conversation engine. `sessions.create(params)`, `sessions.join(threadId, params)`
and `sessions.fork(threadId, params)` map to native start, resume and fork.
They retain the native response, including effective settings, as `session.native`.
Joins by ID cannot also supply `history` or `path`; advanced alternate-resume
forms remain available through RPC with their native precedence rules.

```ts
const session = await client.sessions.join(threadId, { excludeTurns: true });
const stopRendering = session.subscribe(view => renderConversation(view));

const turn = await session.startTurn({
  input: [
    { type: "text", text: "Describe this image.", text_elements: [] },
    { type: "image", url: imageDataUrl },
  ],
});
// This point means the turn was acknowledged, not completed.
const outcome = await turn.completion();

stopRendering();
await session.leave(); // Unsubscribe this connection; do not interrupt the agent.
```

`join` is an explicit operation that may activate an existing goal. It does not
promise passive attachment. The paginated join form above is a proposed delivery
target requiring the C2 qualification in the implementation plan; the spike's
full late-join matrix covered legacy history. No unsupported join mode silently
falls back to a new thread or a different history contract.

`session.startTurn` registers state tracking before dispatch and returns a
`RunningTurn` handle after acknowledgement. A concurrent start can return the
already-active turn ID while adding another user message. `RunningTurn` therefore
does not assert that this caller created a new execution. `completion()` observes
that turn's completed/interrupted/failed outcome; connection loss rejects the
wait with unknown outcome and retained last state.

Expose `session.steer({ expectedTurnId, input, ... })` and
`session.interrupt({ turnId })` with explicit native identities. Preserve stale-turn
errors. Successful interrupt acknowledgement is followed through to native state;
it is not proof every background process stopped. Goal, queue, revert and compact
operations are initially available directly through RPC, with their effects
documented beside examples. Fork/revert do not clone or restore the workspace.

Within one connection, a thread has one shared local session state. Multiple UI
listeners can subscribe to it; removing a listener is local only. `leave` explicitly
unsubscribes the connection and affects all local views of that thread. It does
not affect another client's subscription. Repeated explicit join calls update
the same local view using a new native resume; they are not assumed harmless.

### Joining and reconciling state

The [057 lifecycle qualification](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/057-launcher-inactive-turns.md)
establishes that an attached idle thread does not expire merely because the user
stops typing. Join/resume once per attachment or reconnect, then submit turns
without a status request before each message. Native `turn/start` does not reload
an unloaded thread. A future recovery helper should preserve the exact rejection,
attachment state and explicit input intent; it must not replay after an ambiguous
transport failure. Whether to recover a known rejected send automatically remains
a client policy to review when that slice is implemented. The launcher stays
transparent and already forwards the relevant errors and closure notifications.

Install thread event/request routing before dispatching resume. Capture the
resume response boundary in the connection's receive order. Merge the returned
snapshot and buffered observations by thread/turn/item identity; reconcile
pre-response events without blindly appending their text again, then apply later
events in order. Paginated history reads can overlap live progress and must not
overwrite newer completed items with an older page.

No server-wide replay cursor or universal text offset was established. A partial
text snapshot and buffered deltas may overlap ambiguously. Preserve both source
observations and mark that item's text incomplete until a complete item supplies
authoritative content. Completion replaces accumulated text. A complete item
does not make the whole transcript complete: native truncation and omitted item
families remain separate coverage limits.

Deduplicate identical recorded observations by source/sequence identity, not by
text equality. Equal text deltas can legitimately repeat. When merging multiple
connections, choose one delta stream per item and reconcile final snapshots;
do not concatenate both clients' copies. Legacy history can rewrite item IDs,
so cross-source matching must retain uncertainty instead of deduplicating by text.

## Server questions and multiple responders

```ts
const stopQuestions = client.requests.subscribe(request => {
  if (request.method === "item/tool/requestUserInput") {
    showQuestions(request.params.questions, async answers => {
      await request.respond({ answers });
      showAnswerSent(); // Native acceptance/winner is not yet established.
    });
  }
});
```

The request handle narrows `params` and `respond` by method. It exposes native ID,
method, scope and local state: pending, response sent, resolved or unknown.
The registry retains requests even before an application installs a handler.
Subscription first delivers currently pending handles, then newly pending ones;
duplicate replay of the same unresolved request updates its existing entry.
`requests.snapshot()` lists current states, and registry state changes are
observable through client diagnostic events. The example's `answers` map uses
native question IDs and answer objects, not a plain list of strings.
`respond` and `respondError` send one local reply; successful send is not a native
acknowledgement that this answer won. A local handle prevents accidental repeat
submission, while another client remains free to answer the same native request.

Replayed requests are keyed by known server lifetime and native request ID.
Only fresh handles bound to the current connection may send responses. Another
server instance reusing ID `0` is a different request. Authentication verification
requests can have native connection-owner restrictions; do not generalize the
tested human/dynamic callback races to every method.

Resolve pending state using native `serverRequest/resolved` where supplied, plus
tool completion/interruption and thread state where appropriate. Dynamic callbacks
did not always emit the resolved notification. Loss of connection makes unresolved
state unknown. Handler exceptions are surfaced locally; they do not fabricate
approval, rejection or successful tool output. Unknown server requests remain
visible through a raw handle. Recorded requests in offline views are data only
and have no response methods.

## Files, processes and images

`client.files` adds byte-oriented conveniences for native filesystem operations.
`read(path)` returns `Uint8Array`; `write(path, bytes)` encodes native base64. Paths
refer to the server host and must follow the native absolute-path requirement.
Metadata, directory, copy/remove and watch operations retain native semantics.
Watch disposal sends unwatch; merely detaching a local renderer does not.

`client.processes.spawn(params)` uses experimental `process/spawn`, returning a
handle with `output`, `write`, `closeStdin`, `resize`, `kill` and `exited` operations.
It allocates a connection-local handle and installs output/exit tracking before
dispatch, so output preceding the acknowledgement is retained.

```ts
const process = await client.processes.spawn({
  command: ["/bin/sh"], cwd: serverWorkspace,
  tty: true, size: { rows: 24, cols: 80 },
  streamStdin: true, streamStdoutStderr: true,
});

const outputTask = (async () => {
  for await (const chunk of process.output) {
    terminal.write(chunk.bytes);
    if (chunk.capReached) showNativeOutputLimit();
  }
})();
await process.write(new TextEncoder().encode("pwd\n"));
await process.resize({ rows: 30, cols: 100 });
await process.kill();
const exit = await process.exited;
await outputTask;
```

`output` has one consumer per handle; multiple UI views use an explicit local
fan-out. Breaking the iterator stops that consumer without killing the remote
process. Native stdout/stderr labels, bytes and cap indicators survive decoding.
PTY streams combine output and alter line endings. The SDK adds no capture cap;
native limits/options remain visible. Streamed final exit payloads need not repeat
prior output. A disconnect invalidates the handle and gives unknown exit status;
the tested native standalone processes were killed on connection close.

`command/exec` remains directly available with its different reply-at-exit
behavior. Thread shell commands/background terminals remain separate native
operations; they have different lifetime, history and permission behavior.
Workspace tools must not be presented as automatically using a selected thread's
sandbox.

Image helpers can turn browser-provided bytes into a native data URL. Preserve
local-image paths as host paths; no automatic remote URL fetch or media upload
service is implied. The application decides whether to retain assets or retrieve
them through host file APIs. Missing local assets and missing model input remain
visible independently from a successful turn acknowledgement.

## Recording, historical analysis and health

**Scope clarification, 25 October 2026:** normal conversation history uses the
provider-native history API. The observation/recording/replay facilities below
are optional diagnostic and analysis inputs, not a requirement to save live-only
events into a second product history. An early development application may enable
debug capture by default so an agent can inspect a reported UI/interpretation
problem through DevTools MCP and AIUI. Keep that explicit application choice
separate from the SDK's opt-in recording interface. Missing native historical
measurements remain missing; optional captures do not imply universal coverage.
See the [working stance](../plans/agent-orchestrator/methodology.md#develop-the-application-with-inspectable-debug-evidence).

Keep existing `pdum.codex_launcher.message/1` JSONL readable. Its source identity,
connection ID, sequence, direction, timestamp and original payload are inputs,
not a global ordering guarantee. Add an adjacent versioned metadata document for
profile/server identity and executable/schema provenance where available. Legacy
recordings without it remain readable with unknown fields; do not rewrite them.
The recorder's `run_id` identifies an observation run; it must not be assumed to
equal the native server lifetime. Metadata explicitly relates them when known.
Recording is opt-in, and routine status does not print message bodies or credentials.

The analysis input is a tagged union of protocol observations, explicitly captured
history snapshots, connection/loss events and optional native telemetry. Each
adapter retains the original source record and declares coverage. Upstream usage
is separate evidence, not a second copy of client usage to sum automatically.

```ts
import { createAnalysis, adaptObservation } from "@habemus-papadum/codex-client/analysis";
import { readObservationJsonl } from "@habemus-papadum/codex-client/node";

const analysis = createAnalysis({ prices: datedPriceTable });
for await (const observation of readObservationJsonl(recordingPath)) {
  analysis.accept(adaptObservation(observation, recordingMetadata));
}
const report = analysis.snapshot({ asOf: recordedEndTime });
```

Offline reading imports no live connection or credentials and cannot issue tool
calls or answer historical questions. Browser file/stream readers feed the same
adapter. Time-dependent health uses a supplied `asOf`; replay never substitutes
the current wall clock for original progress timing. Clock domains are retained;
monotonic times from different processes are not directly comparable.

Public analysis output distinguishes:

- Native thread/turn state from transport freshness and outstanding background work.
- Pending questions, visible tools/failures, child links and repeated-call hints,
  with source references. Thresholds are caller-supplied advisory calculations.
- Item coverage: complete snapshot, missing prefix, native truncation, unknown
  variant, partial page or absent recording interval.
- Observed usage increments, latest native cumulative usage and inherited fork
  baseline. Counter drops/resets and missing initial observations remain uncertain.
- Cost amount, dated price-table identity, model/tier attribution confidence and
  unpriced usage. Context occupancy is separate from cumulative spend.

Counts use stable identities and increments. Sum distinct children's work once;
exclude inherited fork prefixes from new branch spend. Input/cache classes are
disjoint and reasoning output is not charged a second time. Preserve requested,
native-effective and provider-observed model/tier separately. Use decimal/fixed
precision arithmetic; missing rates or ambiguous mixed-model intervals stay
unpriced. Warmup billability and subscription invoices remain unknown unless
separate evidence establishes them. Price tables are explicit inputs, not fetched
automatically or baked into state reduction.

The initial Python/TypeScript bridge is the observation format. A Node process
can read completed captures or an explicitly supplied live observation source and
run the same functions as the browser. Python processors remain simple exporters
or use separately tested Python computations. No per-plugin Node workers,
cross-language RPC framework or live observation endpoint is assumed here.

An SDK observer sees its own connection. A passive launcher recorder misses
thread events while no subscribed client receives them. Native telemetry can add
unattended-work evidence; hosted Logfire delivery and an always-on subscribing
observer remain separate qualification tasks. The latter cannot quietly resume
threads because that can activate goals.

## Compatibility promises and delivery limits

Initially qualify current Chromium plus Node 22/26 through TCP WebSocket and the
existing relay, with macOS and Linux native fixtures. These are targets until CI
and actual browser checks pass. Other browsers, remote hosts and native transports
are reported separately. Keep a capability matrix by binary/revision, operation,
platform and test type. An exported type is not a successful compatibility test.

The first package includes the full typed/raw protocol and the proven convenience
subset. Additional native methods can remain low-level without being excluded.
Automatic recovery, durable background terminals, a pet/swarm scheduler, cloud
profile discovery, filesystem snapshots, automatic remediation and a universal
cross-provider conversation abstraction are separate designs. Claude continues
to use its official clients and existing launcher.

The [implementation plan](../plans/codex-client.md) assigns acceptance gates to
these contracts. Review this design before creating manifests, runtime code or
release changes. The existing four Python distributions and human-operated
release workflow remain as they are during this documentation step.
