# Codex client implementation plan

**Status: proposed for review, 14 October 2026.** Implementation has not started.
The user requested a design review before construction. Read the
[API design](../specs/codex-client.md) for contracts and the
[combined findings](../codex-client-findings.md) for supporting experiments.
This plan does not authorize publishing a package or changing release workflows.

**18 October update:** the design was reviewed as a baseline, followed by the
[HP Agent spikes](../hp-agent-findings.md). Their proposed client refinements
should be folded into C1/C2 before production construction. A separate
`agent-history` package now occupies the production TypeScript workspace.
The [behavioral follow-up](../hp-agent-behavior.md) adds tools, explicit compaction
and model-selected child evidence; it recommends preserving host/runtime/history
boundaries when refining this plan, not promoting the prototype wholesale.
The [power-user parity inventory](../hp-agent-parity.md) is the subsequent design
checklist: preserve separate note/follow-up/steer/wait/interruption semantics,
native user queues and multi-client request arbitration. Selected HP control
behavior is now implemented in research; broad native parity remains unclaimed.
The [parallel work round](../hp-agent-work.md) qualifies independent job and
wait lifetimes, graceful client detach, and explicit runtime ownership. Preserve
those distinctions when introducing client job handles; the
[AIUI contract](../specs/hp-aiui-integration.md) remains a separate integration plan.

**Application direction:** the [agent orchestrator component map](agent-orchestrator/index.md)
is the intended real consumer: Codex, official Claude clients and HP in a browser
workspace spanning configured hosts/profiles. Its twenty-two cards are design stubs
for user refinement, not an implemented app. Use mocks and selected vertical
slices to guide this SDK; C1–C5 remain a technical checklist rather than a reason
to finish the whole client before reviewing UI. Multi-host profile/auth/launch
management belongs beside the Codex SDK, beyond the narrow `/launcher` adapter
described below. The eventual orchestrator can consume the reusable reference
components without making the SDK depend on AIUI.
The accepted [unified host coordinator](agent-orchestrator/components/21-host-coordinator.md)
will own that management boundary, with foreground and optional daemon hosting.
Its [recovery policy sketch](agent-orchestrator/failure-recovery.md) permits an
explicit or policy-enabled reconstruction/relaunch from history after loss;
this does not turn SDK transport reconnect into automatic action replay.
The [working method](agent-orchestrator/methodology.md) now governs each slice:
review which questions need answers, make action intent explicit, and expose any
later inferred choices. The [first-slice proposal](agent-orchestrator/first-slices.md)
now includes two explicitly requested parallel throwaway UI mocks and targeted information-placement measurements;
the entire C1–C5 checklist is not a prerequisite for a visible reviewable slice.

## Intended result

Review [runtime contracts and gotchas](../runtime-contracts.md) before each
affected slice. RC-02/RC-03/RC-05/RC-07 inform attachment, resume, input delivery
and recovery checks; RC-04/RC-06 govern promises about background work and timeout
configuration. These are versioned integration facts, with policy choices still
open where marked, rather than additional implemented SDK behavior.

Deliver one TypeScript package that works from a browser and Node, with complete
typed access to the selected native protocol and a small set of useful higher-level
operations. A reference UI and Node examples exercise the package itself.
An offline tool uses the same analysis without connecting to Codex.

The first user-review milestone is deliberately concrete:

1. Connect to an endpoint from the existing Python launcher.
2. List sessions and read saved history without loading an agent.
3. Explicitly join or create a conversation and send a short turn.
4. Join from a second browser; answer a native question from either client and
   reconcile the result in both.
5. Disconnect/reconnect and show incomplete or uncertain state honestly.
6. Close app-server, then read the recording in a separate offline process.

Basic transcript replay belongs in this first milestone. Richer cost/health
analysis follows without changing the recording boundary.

## Proposed repository organization

```text
typescript/
  package.json                 private pnpm workspace and shared dev commands
  pnpm-workspace.yaml
  pnpm-lock.yaml               one lock for this production TypeScript workspace
  tsconfig.base.json
  packages/codex-client/
    package.json               proposed @habemus-papadum/codex-client
    src/protocol/              generated types, registry and provenance
    src/connection/            transport, routing, request lifecycle
    src/client/                history, sessions, files and processes
    src/analysis/              pure computations and input adapters
    src/node/                  file recording/replay; optional native transports later
    src/launcher/              existing status/capture/stop HTTP adapter
    tests/                     public API, local transport and native integration
    tools/                     explicit protocol generation/checking
  examples/codex-client/        browser reference UI and Node usage examples
docs/specs/codex-client.md      contract under review
docs/plans/codex-client.md      work and acceptance gates
```

Extend the existing workspace after reviewing the follow-up refinements. It stays
independent of Python's root uv workspace, `experiments/` and the Claude example.
Preserve its catalogue/lock and existing agent-history package; do not replace
workspace tooling or promote research scripts wholesale. Ordinary Python
installation must not acquire Node or a native Codex runtime dependency.

Begin with TypeScript, a small test/build setup and existing platform WebSocket
APIs. Pin concrete tooling during C1, using installed versions where appropriate.
Use a Node-specific WebSocket dependency only if the chosen adapter needs it;
keep it out of browser imports. Choose a decimal implementation or fixed-precision
representation during C4. No UI framework or telemetry SDK is required by the
core package.

## Delivery stages

| Stage | Dependency | Reviewable output |
| --- | --- | --- |
| C0 — Review | This document and API design | Accepted boundaries, proposed names/layout and first milestone; no runtime edits yet. |
| C1 — Protocol and connection | C0 accepted | Generated types, typed/raw RPC, server requests, diagnostics and versioned observations. |
| C2 — History and shared live conversation | C1 | Two-browser reference workflow plus Node/offline examples; first user review. |
| C3 — Administration and workspace tools | C1; coordinate session shapes with C2 | Tags/notes, richer history, images, native files and interactive processes. |
| C4 — Shared accounting and health | C1 observation contract; reuse C2/C3 evidence | Live/offline analysis parity, explicit coverage and one local telemetry integration. |
| C5 — Compatibility and package readiness | C2–C4 | Built-package/browser/platform evidence and current documentation; maintainer controls release. |

After C1, administration/process work and analysis adapters can proceed in
parallel with session work. Agree shared types before delegation. Keep root
manifests, lockfile, generated schema, navigation and CI changes under one owner.
Do not maintain competing connection or request registries in separate tracks.

### C0 — Review the proposed contracts

Confirm the one-package layout, native-plus-convenience API, explicit history/join
boundary and browser/Node scope. Review the usage examples for the intended
application flow. The SDK's own disconnect/retry behavior and the observation
format are important contracts to settle early.

The recommendations already preserve multiple responders, trusted-network access,
native configuration and Python process ownership. No new product requirements
are needed to start C1 once this review is complete. Keep remaining compatibility
questions assigned to their relevant stage below.

### C1 — Establish the protocol and connection foundation

- Generate full/stable exports from the pinned source build. Build a complete
  method/parameter/result registry from matching source metadata; preserve
  attribution and generation provenance. Check in generated public types.
- Compare release 0.162.1 and clean `6c372fb` as distinct targets. Record actual
  executable identity when the owning launcher supplies it. Do not infer build
  identity from the clean build's `0.0.0` version string.
- Implement a transport interface and TCP WebSocket adapter usable by browser
  and Node. Route requests, responses, notifications and server requests on one
  connection; send initialize/initialized in the correct order.
- Implement native errors, not-dispatched versus unknown-outcome errors, local
  cancellation, late-response observation and explicit close. Register all
  completion handlers before send. No implicit reconnect or request retry.
- Expose full typed RPC, raw extension access, original observations and pending
  server requests. Separate protocol routing from queued user consumers and
  recording. Report backlog/bytes/errors without initial admission caps.
- Finalize adapters for existing launcher message JSONL and an adjacent metadata
  manifest. Include connection lifetime, direction and source sequence. Keep
  observer identity distinct from the native process's identity.

**Acceptance:** compile-time tests establish known-method parameter/result and
callback-result typing. Importing the browser or analysis entry point loads no
Node built-ins, opens no socket and launches nothing. A real local WebSocket
peer tests response ordering, overlapping string/numeric IDs, events arriving
before replies, malformed envelopes, unknown variants, timeout/disconnect and
handler failure. Fault injection is evidence for those mechanics, not provider
compatibility.

Against native app-server in isolated unauthenticated state, initialize, list
threads, query models/config and execute a harmless standalone command. Verify
experimental gating and native errors on both binaries. Generate a compatibility
report; exported-but-untested methods remain labelled as such. Schema regeneration
is an explicit developer command, not a consumer-install or import side effect.

### C2 — Deliver history, live participation and basic replay

- Add thin thread/history conveniences, explicit pagination and immutable local
  conversation views. Preserve full versus summary and legacy versus paginated
  provenance. Never resume to repair a failed history read.
- Implement create/join/fork session handles, turn acknowledgement/completion,
  steering, interruption and explicit connection-level leave. Several local
  renderers can share a session without owning its native lifecycle.
- Buffer resume-time observations and merge snapshots by native identities.
  Do not concatenate ambiguous snapshot/delta overlap; mark missing prefixes.
  Completed items replace streamed state without erasing truncation indicators.
- Track pending human/dynamic requests across joins and race responses from two
  clients. Local response-sent state must not claim it won. Handle native
  connection-owned verification requests separately.
- Add Node file recording and basic offline transcript reconstruction using the
  same observation adapter. Offline request objects cannot send responses.
- Build a small browser reference UI: endpoint entry, catalogue, history view,
  explicit join/create, prompt, pending questions, turn status and raw event panel.
  A second tab is a second real client. Add equivalent Node examples.

**Targeted qualification before finalizing join behavior:** repeat late joins in
paginated mode, including pending questions and partial text. Exercise
`excludeTurns`/initial page support with both binaries and establish how paging
overlaps the live tail. This was an explicit gap in 028; test it inside C2 rather
than starting another broad research round. Test interrupted fork/request state
before claiming that particular convenience supported.

**Acceptance:** run the six-step first milestone through actual browser controls.
Assert history reads after restart leave `thread/loaded/list` unchanged and issue
no turns. Confirm read and resume remain distinct even with an active goal.
Race two answers; reconcile the winner from native evidence. Disconnect all
clients during work, reconnect explicitly, and show the gap. Reproduce the
duplicate-submission behavior and verify the SDK never retries it automatically.
Close the server and replay the recording with no network or authentication.

The same API must work in Node. Compare direct native Node control with the relay
where diagnosing a transport difference. Keep the existing vanilla Codex remote
CLI interoperability check intact if launcher integration changes. The native
server/relay are dependencies, not implementations to replace for this milestone.

### C3 — Add administration, files, processes and rich input

- Add catalogue reconciliation and native names/projects/sections/attachments.
  Keep raw page results available. Preserve source filters, archive behavior,
  duplicate-ID evidence and per-thread versus global search scope.
- Expose attachment add/remove/owner lookup and native read-state revision
  conflicts. Verify any future replacement helper's multi-client semantics;
  do not label add-by-existing-key as an update.
- Add byte-oriented filesystem helpers and watch lifecycle. Retain absolute host
  paths, symlink behavior, native errors and change notifications.
- Implement process handles with immediate spawn acknowledgement, queued output,
  stdin/EOF, PTY resize, exit and kill. Keep command/exec and thread shell commands
  accessible with their different semantics.
- Add browser image-data helpers. Preserve native local-image inputs and render
  missing assets explicitly; avoid a hidden fetch/upload/storage service.
- Add the small `/launcher` HTTP adapter only for existing status/capture/stop
  operations. Profile listing/launching remains outside this interface.

**Acceptance:** repeat the 030 matrix through the package, including binary bytes,
stdin, stream separation, PTY dimensions, output-before-reply, native caps,
timeout/nonzero exit, handle scope and disconnect. Test an exact multi-megabyte
file round trip without an SDK-imposed truncation limit. Operate the terminal
from actual browser controls. Native threads must not be created by standalone
files/processes. Use disposable paths and verify owned-process cleanup.

Submit one known image through the browser/package API; inspect saved history
after restart/fork and distinguish host paths from displayable bytes. Exercise
the picker with a fixture accessible to the automation tool; retain a canvas
fixture as a separate protocol test. Probe only additional input forms needed
by a convenience being added. Keep untested forms accessible through typed RPC.

### C4 — Deliver reusable cost and advisory health

- Implement a source-aware transcript/usage/health reducer in `/analysis`.
  Inject time and price tables. Keep raw messages alongside derived observations;
  unknown fields/variants and missing intervals survive normalization.
- Adapt protocol recordings and native history responses separately. A history
  adapter reports absent usage/timing/request data rather than manufacturing it.
  It can still derive useful visible tool and transcript facts.
- Separate native cumulative totals, observed increments and inherited fork
  baseline. Deduplicate repeated snapshots; handle counter decreases, children,
  mixed-model/tier changes and unattributed intervals explicitly.
- Add observed pending work, failure/repetition hints, progress age, context
  estimates and cost. Keep stale/disconnected and unknown distinct from stopped
  or healthy. Thresholds remain application input; no automatic remediation.
- Read optional native telemetry through a separate adapter with declared
  coverage. Reconcile known response identities without adding overlapping
  upstream/client/native totals or pretending absent IDs are available.
- Demonstrate one Node analyzer consuming recorded launcher output and one
  browser using the same functions. Python capture remains a producer; a live
  cross-language exporter is a separate, explicitly scoped integration if needed.

**Acceptance:** feed one recorded real run through live-client analysis, Node
analysis and offline replay; compare final state for equivalent input. Exercise
duplicates, dropped/truncated tails, unknown variants, restarted scopes,
forked prefixes, stale snapshots and mixed-model price fixtures. Reuse curated,
credential-free extracts for regression tests; original captures stay ignored.
Separate synthetic parser/accounting cases from live compatibility evidence.

Compare a small local OTLP collector with client evidence for a real sandbox
denial and compaction. Verify metrics behavior by binary/configuration and test
slow/unavailable sinks without stalling client operations. Hosted Logfire is
qualified only when a destination is configured and receipt is verified; its
absence does not block local analysis. An always-on observer with no controlling
client requires its own lifecycle check before it is offered.

### C5 — Qualify packaging and supported environments

- Build the npm package and consume the resulting tarball from separate browser
  and Node examples. Verify public exports, declarations, no Node leakage into
  browser bundles, and offline analysis with no live imports.
- Run Node 22/26 compatibility and actual Chromium checks. Qualify macOS/Linux
  native process and filesystem cases separately; track remote-host behavior
  rather than extrapolating it from loopback.
- Add credential-free CI with pinned native versions where installation is
  supported. Ordinary PR jobs do not receive provider credentials or run models.
  Gate source-build-specific assertions on their actual binary instead of
  silently skipping required features while claiming the full matrix passed.
- Publish package documentation covering activation, retries, disconnect,
  multi-client requests, history completeness, native limits and cost uncertainty.
  Update implementation status only for completed gates.
- Preserve raw protocol access and the experimental compatibility matrix as
  conveniences grow. Review generated diffs explicitly on upstream upgrades.

**Acceptance:** consumer builds and the relevant tests pass from built artifacts;
unsupported/untested combinations are visible. The maintainer receives release
evidence. The proposed npm name must be checked and version/release integration
decided before publication; these tasks do not alter the four Python packages'
lockstep versions or dispatch their release workflow.

## Verification, cost and hygiene

Use real local peers/processes for transport and failure mechanics, and native
app-server for compatibility. Keep fixtures for hard-to-repeat races and failures
with provenance explaining what they prove. An accepted request is not proof a
model turn, image decode or exporter delivery completed.

Provider acceptance probes use exact `gpt-6-luna`, isolated profiles/workspaces,
explicit turn/tool/time/retry bounds and one coordinated ledger. Aim for
$0.05–$0.10 per investigation under the repository's normal allowance; record
dated API-equivalent estimates separately from missing usage and subscription
billing. The previous $5 authorization applied to the completed spike round;
this plan does not consume it or start new paid work. No model substitution or
credential dumping is part of test fallback.

Do not depend on private spike artifacts for a fresh checkout's ordinary suite.
Make small reviewed fixtures from necessary observations or regenerate evidence
through explicit opt-in probes. Keep credentials, ordinary profiles, full raw
captures and build output ignored. Preserve original research evidence and links.

Future workspace commands should expose lint/format, type checks, tests, package
build and example build. Exact commands are added with C1 tooling rather than
documented as available now. Run strict MkDocs and link checks for documentation.
Report local tests, native tests, browser checks and paid checks separately.

## Completion report for each stage

Record the public API added, why its semantics follow the native protocol, exact
versions/platforms exercised, tests that passed, known gaps, new provider usage
and the next dependent gate. Link evidence to the design. If a native behavior
changes the contract, revise the proposal and examples before claiming the stage
complete. The first review is C2; finishing every optional method or hosted
exporter is not a prerequisite for reviewing a usable client.
