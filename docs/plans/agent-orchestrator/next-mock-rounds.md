# Next orchestrator mock rounds

**Agreed sequence, 19 October; status and closing direction updated 25 October 2026.**
This tracks the original eight spikes plus the 066 authentication, 067 live,
and 068–071 architecture investigations. Rounds A/B and the live workspace have
had positive interaction review; 066 passed bounded live qualification. The two
closing integration studies are implemented. The user then requested one focused
Claude ownership/replay spike and a provider evidence matrix before agreement on
backend architecture and client interfaces. We are closing the broad mock phase, not trying to complete every UI
feature or protocol interpretation before implementation.
These remain disposable studies, not production SDK contracts or settled backend policies.
The [full system/library proposal](system-design.md) and its
[implementation plan](system/implementation.md) are now the review deliverables
that follow this research sequence. No additional broad mock round is scheduled.
The 24 October implementation clarification calls for **working applications over
real data and existing operations**, with synthetic cases only where useful for
a specific experiment. Throwaway code need not establish production architecture
or a comprehensive test strategy.

## Working boundaries

- **Historical session browsing follows provider-native history:** Claude's
  official SDK helpers and Codex's app-server protocol. Temporary exports or
  captured files may supply the mock, with their source and limitations visible.
- **DuckDB is the ingestion/statistical path.** Its configuration is the existing
  ingestion tool's configuration, not a parallel application-owned replacement.
- Before designing a configuration screen, read its owning implementation and
  CLI/library contract. Record a small mapping from UI choice to existing field,
  command or operation. Mark unsupported behavior as a proposal. A transient
  form model is allowed; an invented durable configuration scheme is not.
- Apply [the working method](methodology.md) and [runtime contracts](../../runtime-contracts.md).
  Inspecting history must not implicitly resume, subscribe to, fork or run a task.
  Preserve native identifiers, host/profile/source provenance, unknown coverage
  and the distinction between stored history and a live runtime.
- Use Solid/AIUI for integrated or stateful views, including source tooling and
  scoped controls/cells. Plain DOM remains acceptable for an exploratory visual
  alternative. The existing local development dock is study scaffolding.
- Native history is the ordinary historical source. Debug captures support joint
  operator/agent development through DevTools and AIUI; they are not a requirement
  to preserve live-only data as a second product history. Early development may
  default that optional capture on. See the [working stance](methodology.md#develop-the-application-with-inspectable-debug-evidence).
- Independent agents own separate folders and reports. Small copies are allowed;
  extraction into reusable packages waits for evidence. The coordinator owns
  shared host, dependency, navigation and plan edits.

## Configuration owners to consult

| Area | Existing owner / source | Mock obligation |
| --- | --- | --- |
| Ingestion | `packages/agent-history/src/pdum/agent_history/config.py`, `sync.py`, `cli.py`; [history guide](../../agent-history.md) | Represent `history.yaml`, its Codex/Claude/profile sources, existing target options, window and blob settings. Preserve supported defaults and target credential references. |
| Codex profiles/config | `packages/codex-launcher/src/pdum/codex_launcher/profiles.py`, `config.py`, `cli.py`; [profile guide](../../profiles.md) | A profile is a Codex home. Keep native TOML/unknown fields; distinguish explicit edits from launch-time overrides. |
| Codex authentication | `packages/codex-launcher/src/pdum/codex_launcher/authentication.py` and mounted CLI | Preview the existing login/reuse/API-key operations and their actual supported parameters. |
| Claude profiles/auth | `packages/claude-launcher/src/pdum/claude_launcher/profiles.py`, `authentication.py`, `cli.py`; [Claude guide](../../claude.md) | Preserve native profile/config/auth ownership. Existing official SDK clients own queries; 068 investigates native stream clients and independent process ownership. |
| History access | Existing Claude management helpers, official SDK history functions, and Codex history methods qualified in spikes 025–034 / runtime contracts | Prefer existing adapters; retain native payloads. No private recovery-format reconstruction or silent resume. |
| Host coordination | [O21](components/21-host-coordinator.md), existing launcher libraries | The unified coordinator remains proposed. Do not present a mock endpoint as an implemented host protocol. |

## Tracker

IDs use new folders after the existing 057 lifecycle follow-up. Status values are
**queued**, **in progress**, **ready for review**, and **reviewed**. Validation
results and links belong in the row before a slice becomes ready for review.

| Round | Spike | Visible result / question | Integration | Status |
| --- | --- | --- | --- | --- |
| A | 058 — Native history access | Read real Codex/Claude sessions through native history surfaces without activating work. Record exactly what is available. | Disposable read adapter/export consumed by 059; no DuckDB dependency. | Reviewed for this mock phase — individual captures, families and rich examples qualified with explicit gaps; evidence/runbooks retained. |
| A | 059 — Rich historical viewer | Dense long-trace reading: prose detail levels, tool pills, phase, minimap and image lenses, with native coverage explicit. | Read-only study beside 054; shared visual direction, no production extraction. | Reviewed and wrapped up — user is ready to move on. See the [handoff](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/059-historical-viewer/HANDOFF.md) for changes, current validation, source limits and deferred work. |
| A | 060 — Authentication flows | Start from machines/profiles/agents, follow sign-in and credential flows, and inspect authentication/expiry state. Explore remote browser sign-in, running-agent timing, Workforce Federation and Bedrock without freezing policy. | Independent user-journey mock; launcher mapping, commentary and open questions sit beside the application. | Reviewed — 24 October: user likes the revised flow; later make the display denser and visually consistent with the other mocks. 15 model/graph/source-map checks; 62 browser assertions. No live auth; backend policies remain open. |
| B | 061 — Ingestion and statistics | Configure the actual ingestor, inspect progress/coverage/errors, and query useful aggregates in DuckDB. | Independent statistical study; later links into 059. | Reviewed in this phase — six real transcripts, 7,870 items; real sync/query/config save and 18 focused browser checks. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/061-ingestion-statistics.md). |
| B | 062 — Launcher connections | Connect to local/remote launchers, discover managed profiles/tasks, and understand disconnect/reconnect and execution location. | Independent management study. | Reviewed in this phase — actual local discovery and worker-free Claude HTTP adapter; connection failure preserves prior evidence. Remote network/Codex HTTP still unqualified. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/062-launcher-connections.md). |
| B | 063 — Profile workbench | Create from a base or scratch, edit provider-native configuration, compare defaults and launch overrides. | Existing profile/config operations represented in an independent view. | Reviewed in this phase — actual Codex/Claude lab profile creation/editing; two shared backend checks and desktop/phone journeys. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/063-profile-workbench.md). |
| C | 064 — History into continuation | Inspect an existing owned lab conversation, choose a supported native resume/fork operation and carry a draft into the live workspace. | Native catalogue and continuation integrated into 067. | Ready for review — both providers resumed/forked with native cutoff/source preservation and unsent drafts; four live continuation inputs. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/064-history-continuation.md). |
| C | 065 — Remaining lifecycle and ownership | Extend launch/end to interrupt, disconnect and owner-stop cases; record effects on other owned work. | Runtime drawer and explicit controls integrated into 067; isolated owner-loss probe. | Ready for review — two active interruption cases, End-all browser check and seven no-model ownership checks. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md). |
| Follow-up | 066 — Claude setup token | Qualify shared authentication with isolated profiles and explicit token replacement. | Existing launcher hook and official SDK. | Live qualification passed; production auth-reference UI remains separate work. |
| Follow-up | 067 — Owned live workspace | Launch Luna/Haiku, submit a real tool-producing turn, and compare live/native history in shared presentation. | Existing launcher libraries, browser controls and 059 projections. | Reviewed in this phase — selected live/history content agrees; differing protocol/measurement coverage documented. |
| Architecture input | 068 — Claude feed replay | Launch a persistent native Claude process, attach two clients, replay stdout and reconcile native responses. | Separate SDK-free transport spike; existing 067 stays unchanged. | Ready for review — real two-client Haiku, permission resolution, zero-client completion and Chrome replay; USD 0.00283440 estimated. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md). |
| Architecture input | 069 — Provider evidence matrix | Compare live, native history, ingestion, replay, continuation and ownership across Codex, Claude and HP Node/browser. | Source-linked synthesis of existing studies plus 068 findings. | Ready for review — four themed matrices distinguish measured behavior, gaps and proposals; no inference. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md). |
| Architecture input | 070 — HP storage and backend parity | Save, close, read, restore/fork and account with the same core and replaceable storage. | Separate research helpers over HP, filesystem/IndexedDB and the existing history writer. | Ready for review — actual Node/browser continuation, compaction, historical forks and SQL pricing; one explicit out-of-turn invariant gap. USD 0.00152492 estimated. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/070-hp-backend-parity.md). |
| Architecture input | 071 — Official Claude SDK reuse | Distinguish earlier SDK qualification from persistent native replay, then test the combination. | Official SDK with client-only replay/connection adaptation over unchanged 068 owner. | Ready for review — actual browser replay/reload, Node root SDK attachment, shared and recovered pending permissions; naive historical callback replay is unsafe. USD 0.00126630 estimated. [Findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/071-claude-sdk-replay.md). |

## Closing studies and architecture handoff

**Proposed stopping point for mocks.** 053/054 established overview and conversation
interactions; 058/059 native history and rich reading; 060/063 authentication and
profiles; 061 ingestion/statistics; 062 connections; 066 token provisioning; and
067 actual live conversations. Their evidence is sufficient to sketch the backend
and client boundaries now. The two remaining studies should test those boundaries,
not expand into another comprehensive mock programme.

| Study | Small working journey | Question it resolves for the interface |
| --- | --- | --- |
| 064 | Use an owned lab conversation, inspect native history, choose resume or a provider-supported fork point, then submit an explicit draft in 067. Preserve the source when forking. | How history references, continuation intent, native identity and live connection handoff fit together. |
| 065 | Reuse launch/end, interrupt an active turn, distinguish closing a view from ending its runtime, and inspect the effect of ending one owned run or its owner while another exists. | Which component owns each resource and what the management/session APIs can honestly report after stopping or losing contact. |

For 064, carry RC-03/05/09/10: inspection must not resume; supported branch
boundaries and source identity must remain explicit; continuing context does not
restore files or tools. Resolve any product choice about branch/draft behavior
when the actual provider operations require it. For 065, carry RC-01/02/04/07/08:
idle is not completion, background work can outlive a turn, and connection/runtime
lifetimes differ. Observe current library behavior and recommend a policy before
fixing an unresolved coordinator-survival guarantee. Both remain disposable real
experiences with focused checks, not production architecture implementations.

The following deliverable is a **backend architecture and browser/Node client
interface proposal for review**, consolidating the existing component map and
Codex client baseline. It should make these decisions concrete:

- One host coordinator's library composition, process ownership and pragmatic
  failure behavior, including its connection handoff to provider clients.
- Management operations for profiles/authentication, launch, status and explicit
  stop; native configuration continues to belong to the existing tools.
- Provider session interfaces and native access, incorporating the revised
  Claude feed/attachment findings and the portable HP runtime's Node/browser
  ownership. Official Claude conversation SDK compatibility is not a requirement
  for the new path; native history helpers remain independently useful.
- Native-history read/continuation interfaces and scoped identities; ingestion
  analytics remains a separate source that can link to history.
- Framework-independent projections and shared display inputs, with AIUI owning
  controls/cells, source attribution and the application/tool interaction surface.
- Optional diagnostic observation/reproduction hooks accessible during development,
  separate from normal history and from a mandatory live-event archive.
- The first production slice, package boundaries, validation strategy and explicit
  deferred decisions, informed by the real working studies rather than copied
  mechanically from their code.

We can stop broad mocking when that ownership/API proposal is reviewable and the
two end-to-end flows have exposed any blocking mismatches. Unclassified messages,
visual refinements and additional edge cases can continue through the AIUI/DevTools
feedback loop while building the real infrastructure. Mosaic refinements,
MotherDuck UI publishing, Electron packaging, richer multimodal input, broader
auth providers and a separate HP UI mock are not prerequisites for this handoff.
Existing HP Node/browser evidence remains an input to the interface design.

**Closing results, 25 October:** 064/065 are available in the existing live page's
Saved sessions and Runtimes panels. Native resume/fork boundaries and draft
preservation work for the selected lab conversations. Interruption, disconnect,
runtime end and owner loss have distinct measured outcomes; Codex process survival
can outlast its usable public endpoint. Unknown ownership is exposed rather than
reconstructed. Total estimate for six new browser inputs: USD 0.00670693.
The studies and runtime contracts retain the limits. No production SDK or daemon
architecture has been selected by the throwaway implementation. The architecture
proposal and client-interface review follow the focused 068/069 investigations
requested below; a new broad mock round is not needed.

## 068/069 — Revised Claude attachment and provider evidence

**Authorized 25 October, two parallel agents.** 068 owns an isolated native
Claude process/feed probe and its report. 069 owns the cross-provider matrices
and their evidence references. The coordinating agent updates shared plans,
runtime contracts and the instruction baseline; existing live pages and
production launchers retain their qualified behavior during the investigation.

The user selects the core boundary: launch and attachment are separate; client
disconnect must not end the new Claude process. The service forwards input into
stdin without conversation validation or manufactured acceptance, records the
process feed, and replays native output to attaching clients. The journal retains
stdin/stdout separately; client delivery contains stdout, never a server-generated
input echo. Native responses
establish outcomes; the clients handle shared state and competing actions. An
official conversation SDK is not required. Full replay precedes live delivery,
with observable progress/boundaries. The process journal may live under the
profile's `.aiui` directory and be reclaimed after process exit. Native history
then supplies resume/fork. This does not promise owner-crash survival.

| Question class | Scope for these investigations |
| --- | --- |
| Already answered | Multiple clients from the beginning; thin server; client-side interpretation; complete unoptimized replay; no private native recovery; ordinary native history remains separate. |
| Technical choices delegated | Transport sequence/replay framing, isolated journal location, native launch flags and bounded real subprocess/network checks. Recording stdin is evidence of transport, never provider acceptance. |
| Investigate before design | Native message echoes and rejection/callback visibility, replay/live ordering, process survival with zero clients, correlation of multiple clients' actions, and data differences across providers/sources. |
| Deferred | Image pruning/snapshots, crash adoption, shared browser-worker hosting, persistent HP stores, and policies for unresolved client-side conflicts. Raise a concrete conflict before encoding a production policy. |

Acceptance uses **RC-07/08/09/12**: retain uncertain outcomes; observe native
output instead of generating acknowledgements; verify process ownership across
detach; keep feed/native-history/ingestion evidence distinct; never re-execute
replayed commands or confuse reattachment with saved-history continuation.
Transport checks use two real network clients and a process, including attachment
while output arrives. Haiku qualification stays bounded, aims below USD 0.10
and has a USD 0.50 investigation ceiling with a usage ledger. 069 adds no model
calls. Raw evidence stays ignored; reports separate measured, source-inspected,
proposed and untested behavior. No comprehensive UI or production SDK extraction
is part of these two studies.

**Results:** the native Claude process supplies user-message echoes, command
lifecycle and accepted permission responses to both clients. A late conflicting
permission answer did not override the accepted one. No server conversation
state machine was needed. Malformed JSON can instead terminate the native process
without a correlated stdout rejection. The narrow regression/evidence contract
is now [RC-13](../../runtime-contracts.md#rc-13-claude-feed-replay-can-use-native-multi-client-outcomes).
The matrix distinguishes current production behavior from this qualified research
path, and HP's offline snapshot replay from the still-unimplemented executable
restore/storage boundary. Six paid inputs total USD 0.00283440 estimated; browser
and transport checks add no model calls. These inputs are ready for the backend
and browser/Node client-interface design conversation.

## 070 — HP storage and backend parity

**070 follow-up, 25 October:** the user explicitly requires storage independence
from filesystem and browser technology. A portable async key/byte seam now has
filesystem, IndexedDB and memory proof adapters. Same-code Node/browser resume and
historical forks passed real Luna after owner destruction, including compacted
context; native history remains separate from analytical ingestion. Existing
writer/SQL totals agree, while an out-of-turn compaction invariant and portable
pricing extraction remain concrete production tasks. See [RC-14](../../runtime-contracts.md#rc-14-hp-history-restores-context-through-host-independent-storage).
The architecture proposal can now incorporate all three runtimes without assuming
HP has already shipped a production management interface or storage engine.

## Round A execution

Three workers can proceed concurrently, with one coordinator integrating the host:

1. **058 source/access lane:** inspect existing readers and native APIs; select a
   small real corpus from isolated previous experiments when available; produce
   local read-only exports and evidence. Keep raw records under ignored artifacts.
   Do not modify ordinary developer profiles or invoke inference for browsing.
2. **059 rendering lane:** begin with declared provider-shaped examples and a
   separate content-stress specimen, then connect 058's real exports. Preserve
   raw payload inspection and unknown blocks. Rich rendering fixtures establish
   rendering behavior, not proof that every provider returns those forms.
3. **060 authentication lane:** inspect launcher/config source and build a
   detached sign-in walkthrough, beginning with a machine and one of its
   profiles. Show agents using that profile and separate auth/expiry information.
   Simulate local/remote provider journeys. Put operation mappings, explanatory
   commentary, scenario controls and unresolved questions outside the proposed
   application. Do not read credentials, launch login, write profiles or start
   workers merely by opening the mock.

The temporary exchange is a local catalogue plus provider-labelled native
documents: provider, native session ID, source/method, capture time and raw payload.
It is a mock transport envelope, not a new persisted agent-history schema or SDK.
Provider-specific rendering adapters may retain different fields. Cross-view
links need only preserve provider/source/session/turn/item identity for now.

Within each lane, work in AIUI's order: **pure adapters and accounting → controls,
durable state and cells → components → reviewable application/tool surface**.
Keep interpretation tests near pure adapters; use real local API reads and browser
checks for integration. HMR, phone layout and keyboard behavior are separate checks.

## Round B execution — 24 October

Two parallel owners implement 061 and the closely related 062/063 pair. The
coordinator integrates preview routes, dependency wiring, navigation and this
tracker. Existing 053–060 work and handoffs remain available for comparison.

- **061:** begin with real local source data, a separate local DuckDB target and
  the ingestor's actual YAML configuration. Exercise save/sync/query and expose
  real coverage, errors and source attribution. Cloud publishing is deferred;
  no provider inference is required. RC-09/10 apply to unknown measurements,
  repeated usage, family identity and duration interpretation.
- **062/063:** inspect real launcher/profile records and existing management
  endpoints, then create and edit lab profiles through the owning libraries.
  Existing profiles are inspection/copy sources, not write targets. Keep native
  config and unknown fields; show saved defaults separately from launch overrides.
  RC-01/07/08 apply to observed status, lost contact and provider lifetimes.
- **Validation:** exercise an actual ingestion and incremental repeat, queries
  against the resulting data, actual lab profile creation/editing, preservation
  of unknown config and ordinary source state, endpoint error/unsupported cases,
  and desktop/phone working journeys. These are focused acceptance checks, not
  a production qualification programme.

The user's configuration-owner, explicit-intent, dense-presentation and real-data
preferences are settled inputs. Layout and implementation details are delegated.
Remote coordinator architecture, live authentication/refresh policies and task
launch/shutdown remain deferred until their owning flow requires a decision.
An unavailable remote service is shown as unavailable rather than replaced with
a simulated successful connection.

**Delivered:** `/ingestion/`, `/connections/` and `/profiles/` in the shared lab.
061 uses copied real raw transcripts, the existing ingestor, local DuckDB and the
production TypeScript query toolkit. 062 inspects real profiles/processes and
provider management HTTP endpoints. 063 creates/copies/edits native lab profiles.
The two implementation owners worked in parallel; a separate focused review
checked consequential accounting, observation and write behavior. Frontend
typechecking/build and strict documentation compilation passed, along with the
focused operation checks in each report. No production package or upstream AIUI
code was changed; new provider inference spend was zero.

For review, begin with the data and working journeys. Mosaic statistical views,
MotherDuck publishing, durable remote discovery, live authentication and task
launching remain later work. The query-source and context-measurement findings
are retained under RC-09 rather than hidden by the display. Round C has not started.

## Review gates and deferred questions

### 067 — Owned live sessions before continuation and lifecycle studies

**25 October, user-selected scope.** Skip Claude discovery and existing Codex
session attachment. Launch fresh conversations through our own launchers, using
one isolated Codex profile and one isolated Claude profile. Use borrowed Codex
authentication and the qualified Claude setup-token reference. The first browser
surface selects provider and working directory, launches, submits simple prompts,
shows streaming work, and compares that session with its saved native history.
Defaults are Luna and Haiku. This is disposable working code over real providers;
production SDK extraction waits for evidence. 064/065 remain afterward.

Three parallel lanes own backend launch/history operations, the compact UI, and
pure provider projections. The coordinator owns browser transports, host wiring,
documentation and all paid qualification. No inference occurs on page load.
The AIUI layer order is projections → scoped state/cells → shared transcript
components → launch/prompt/history application. Existing 059 interpretation and
rich rendering are reused where their boundaries permit; a temporary common view
shape does not erase native records, identity, timing or missing fields.

Acceptance connects RC-01/03/05/07/08/09/10/11 to concrete checks: explicit new
sessions and turns; native errors and unknown delivery without replay; reading
history without resume; live tool/message projection and saved data from the same
identity; correct usage scope; and cleanup of owned runtimes. Codex and Claude
retain different disconnect lifetimes. End runtime is explicit. No native
credential refresh or live attachment to the developer's ordinary sessions is
implied. Test writes and provider probes use an ignored sample working directory.

Settled inputs: real data, two lab profiles, provider-owned config, explicit
intent, dense presentation and no arbitrary native recovery work. Engineering
choices for this slice are delegated. Steering/queue policy, full callback forms,
multi-client control, cross-host connections, continuation and general shutdown
policy stay with their owning later slices. User-invoked sessions do not inherit
the automated probe's turn/budget bounds. Qualification aims below USD 0.10 with
no model substitution; failed attempts and dated estimates remain in the ledger.

**Delivered for review:** `/session-lab/` now runs actual browser conversations
through both launchers. One tool-producing turn per provider succeeded; the same
session's native history matched the visible conversation/tool content. Extra
protocol records, differing native identities and missing history measurements
remain explicit. Eight real no-model backend checks, six projection regressions
and desktop/phone interaction checks accompany the selected live evidence.
Estimated provider cost is USD 0.00292343. See
[067 findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/067-live-session-workspace.md).
Both test runtimes ended; isolated profiles remain available for operator use.
No production SDK package was extracted. Review this experience before 064/065.

**25 October follow-up:** the user reviewed the Round B pages positively and
requested a Claude-only long-lived-token spike before further work. Spike **066**
uses the existing launcher hook and official SDK; no-model isolation/cleanup
checks passed. After an initial token rejection and input repair, a replacement
passed all 11 live checks across two profiles. New allocations use the current
credential reference; an existing worker keeps its supplied environment. The
reported total was USD 0.000219, with cleanup verified. First-class production
auth configuration, remote transfer and renewal remain separate work.
The operator has no eligible Codex Business/Enterprise account, so its workspace
token spike is excluded. This does not start Round C or settle live auth policy.

| Needed when | Questions to resolve / evidence to review |
| --- | --- |
| A review | Is the real-history layout useful? Which native gaps matter? Is read-only unmistakable? Can the user find a profile, understand who uses it, and follow its sign-in journey without reading engineering commentary? |
| Before B ingestion implementation | Which existing sources/targets and configuration operations should the first usable UI expose? Which ingestion failures need operator action? |
| Before B profiles/connections | Which native profile operations are most valuable; how should base copying and remote host selection appear? No implicit new inheritance scheme. |
| Before C | Choose resume/fork point semantics, draft handling, cross-view navigation, and effects of task/server shutdown. Refer to RC-01–RC-08. |
| Before live control | Qualify authentication while agents share a profile, credential pickup, reliable expiry/refresh evidence, per-provider remote sign-in and cancellation/recovery. Decide timing policy with the operator after evidence. Federation/Bedrock require their own provider/config owner. See the 060 question register. Existing authorization is not replaced by repeated confirmation screens. |

Advanced voice/pencil composition, container recovery and broad health automation
remain in their existing component cards. This round exercises image rendering
and exposes evidence for later health calculations; it does not implement all of
those systems.

## Evidence and updates

Each spike delivers a web surface where useful, a short findings document, a
reproduction note, and an honest list of real versus simulated operations. Record
provider usage and dated cost estimates separately from assistant effort; the
initial A plan requires no paid inference. Ask for input only when an unresolved
product choice becomes a dependency, not for every provisional layout choice.

- Plan recorded; source/configuration ownership review completed for A.
- Round A implemented in disjoint folders; the shared lab links both new views.
- 058 exported 16 real sessions through native read surfaces, retaining raw payloads
  in ignored artifacts. Native errors and missing usage remain visible.
- 059 provides the read-only viewer; 060 is a simulation of existing authentication
  operations with a source/CLI operation map. No login or profile write was executed.
- On 24 October, authentication review requested a user journey based on machines,
  profiles and their agents. The revision keeps profile identity stable across
  method choice and moves engineering commentary and unanswered questions aside.
  Running-agent timing, expiry semantics and remote/federated flows remain
  illustrative until investigated; no live policy was selected.
- On 24 October, history review approved denser prose/tool presentation, a minimap, image lenses and real long/rich examples. The revision records native data limitations separately from unfinished estimators, and keeps S3/MotherDuck asset integration and fork-tree placement deferred. See the 059 report and visual preferences.
- Follow-up history review produced the [behavior evidence inventory](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-evidence-inventory.md): 27 provisional questions, an audit of the 23 native exports, and bounded family/time/image collection steps before another minimap iteration. The time-gap threshold and graphics backend remain open; see RC-09.
- The [family/duration collection](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-agent-family-evidence.md) now qualifies one complete selected Codex family and two Claude listings with explicit parent-link gaps. Paginated clocks and duration semantics are recorded in RC-10; the family/time viewer now uses these exports with explicit coverage, unknown clocks and scoped durations. Its temporary types remain provisional; the availability ledger guides future SDK extraction.
- Rich-message review now has [six direct native-message examples](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-rich-messages.md): human image prompts and assistant math updates/finals. The mixed-provider collection is explicitly independent captures; missing human TeX/assistant-image examples remain documented.
- The user wrapped up the historical mock phase on 24 October. Round B is queued
  for the main agent; Round C remains after B review. No B/C implementation was
  started by the historical fork.

### Round A review links

The lab exposes `/history/` and `/auth/`, with per-study Markdown notes. Existing
overview and conversation mocks remain available alongside them. From the
repository, read the reports at `experiments/docs/spikes/058-native-history-access.md`,
`059-historical-viewer.md` and `060-authentication-flows.md`; reproduction and
operation mappings are in the matching spike folders.

Review the historical rendering/coverage first, then try finding a profile and
following its authentication journey. The accompanying commentary records
feasibility questions without requiring them all to be answered now. Backend
configuration owners have not changed. New provider
inference spend for Round A is zero; original captured-session usage and assistant
implementation effort are separate.
