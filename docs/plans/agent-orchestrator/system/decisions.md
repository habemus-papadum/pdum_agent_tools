# Decisions, evidence and component coverage

**Review register, 26 October 2026.** Read the [short system proposal](../system-design.md)
first. This separates previously agreed direction, new engineering recommendations
and product questions that should be answered only when their implementation
depends on them. It follows the [working method](../methodology.md); it is not a
new permission system or an interview that must be completed in full now.

## Recorded review — 26 October 2026

The user accepted the library boundaries and supplied the guidance below.
These are design decisions, not claims of implemented behavior. D4 records the
interpretation of the discussion: avoid selecting a primary Claude observer
unless a concrete callback capability makes that unavoidable. Do not introduce
election or ownership machinery preemptively.

| ID | Proposal / question | Current evidence and recommendation | Needed by / owner |
| --- | --- | --- | --- |
| D1 | Library boundaries and first workflow | **Accepted:** one new Python coordinator; six new TS libraries; extend existing history; reuse AIUI. Keep the staged first Codex workflow and subsequent independent lanes. | Agent owns routine module/type choices; no repeated library-boundary approval needed. |
| D2 | Which scopes/defaults should the application remember? | **Direction settled:** derive launch host/project/cwd from the UI action's context, show their source, and allow review/override. Model/effort/tier changes are working overrides that carry into the next turn in that conversation. Saving profile/application defaults is a separate explicit action. Include a worktree launch choice, preferring qualified native/existing provisioning. | S1; detailed scope rules below. Ask about unresolved reload/cross-view persistence only when a concrete case needs it. |
| D3 | Keep selected Codex work attached after all browsers leave? | **Settled for now:** no retained host subscription for observation or keepalive. Offer longer-than-30-minute unload timing in creation/launch. RC-06 makes this a server-start override, shared by threads on that server, not a per-thread setting. | S1: expose actual scope and inherited value on an existing server. Exact longer default is not selected; do not silently restart a shared server or persist the override globally. |
| D4 | Who owns client-executed Claude hooks/MCP callbacks? | **Avoid a primary-client layer:** use native outcomes and client-side reconciliation for shared observers. Only revisit a minimal owner-selection mechanism if a specific callback demonstrably requires it; no server semantic arbiter. | S2 when that actual capability is exposed; bring the concrete case back rather than implementing speculative election. |
| D5 | HP save/restore and browser lifetime policy | **Delegated initial recommendation accepted:** storage-independent adapters, completed checkpoints, fresh-owner restore and no automatic replay of unfinished tools/mail/jobs. The initial save/failed-save policy is documented below. | S3 implements and tests that narrow policy; broader durability, cross-tab hosting and in-flight recovery remain later questions. |
| D6 | What does a tag/comment apply to, and where is it stored? | **Deferred by the user:** discuss concrete examples at the natural implementation point. Native Codex attachments, corpus annotations, logical conversations, source copies and file selections are distinct; do not choose their relationship silently. | S5 before durable cross-provider tagging/source comments; O14/16/17. |
| D7 | When should credential changes affect running work? | **Settled:** keep it simple and session-independent. Perform the selected login/reference change without coordinating other sessions, pausing/draining work, credential leases or busy-profile guards. Let native behavior/errors occur and surface them; add coordination only if later experience calls for it. | S2/S5; RC-11 still distinguishes status from access, but neither status checks nor other sessions become new authorization gates. |
| D8 | Which packaging and remote hosts are needed first? | **Accepted:** browser + isolated foreground backend first; reuse the frontend if Electron later earns its place. Peer hosts retain their own profiles/runs. | S0; desktop/remote specifics when needed, O05/21/22. |
| D9 | Which health/recovery actions may be automatic? | **Accepted:** shared evidence/advisory calculations first; stale/unknown is not failure. Keep recovery explicit and avoid blind action replay. | Ask before introducing automatic mutations/thresholds; O15/18/21. |
| D10 | Which richer prompting workflow comes first? | **Settled initial scope:** a simple text-only composer emits a structured/rendered prompt through the common content boundary; each destination formats it into native messages. Rich prompting, images and multimodal authoring are developed in independent disposable side experiments and do not gate the main workflow. | S0/S1 define the seam; S5 keeps the placeholder useful. Integrate richer authoring only after its separate review. |

Before each slice,
revisit the relevant rows and ask only questions that block that slice's promised
behavior. A deferred operation can remain explicit and unavailable rather than
being implemented with a guessed policy. Already agreed choices below should
not be asked again unless new evidence changes their implications.

### Context, overrides and worktrees

Resolve a launch from the context where the action occurred. For example, New
agent from a selected project on host A in directory B starts with A/B; a previous
launch on host C must not silently win. Show resolved values and their origins,
and let explicit form edits override them. Previewing these values starts no work.
Reviewable does not require a modal confirmation: a compact visible value/origin
and an override control are sufficient.

Keep saved application/profile/HP-recipe defaults separate from a conversation's
working settings and the actual effective settings reported by its provider. A
model override used for one turn becomes that conversation's next-turn selection
until changed/reset, without editing saved defaults or sibling conversations.
Only an explicit Save as default action writes the named default scope. Use native
operations with the intended scope; verify they do not persist those default
keys. Do not implement temporary overrides by editing and later restoring global
settings. Multi-client effects within one conversation follow native outcomes,
without adding a settings lock or cross-session coordination scheme.

Add a workspace choice for an existing directory/worktree or a requested new
worktree. Prefer a provider's supported native launch option or an existing
workspace provisioner. Verify support on the actual headless/app-server launch
path before advertising automatic creation; an interactive CLI flag alone is not
proof. Record base repository, requested branch/worktree and resolved cwd. Keep
conversation forks separate from workspace creation. A custom Git worktree
manager is not a prerequisite; unsupported creation can use an existing worktree.
Branch naming and removal behavior should follow the selected owner and be
reviewed at their concrete implementation point.

### Initial HP persistence policy (delegated engineering recommendation)

Use one writer per runtime/archive and the qualified portable storage interface.
Request an asynchronous save after a completed turn and after a compaction outcome
(including the usage of a discarded result);
record the last committed checkpoint separately from current in-memory state.
Show pending/failed persistence and keep execution independent of the storage
write. On failure, the last committed history remains readable and the user can
retry saving; do not roll back tool effects or restart work. An orderly owner
shutdown attempts to finish pending saves and reports failure. Abrupt loss may
leave the newest work uncommitted.

Restore from an explicitly selected committed completed checkpoint into a new
owner. Incomplete turns, pending mail and running jobs remain inspectable evidence,
not executable recovery. Filesystem and IndexedDB are initial adapters, not a
permanent storage-engine choice. Eviction guarantees, arbitrary in-flight recovery,
multi-writer coordination and cross-tab execution remain outside this first policy.

### Simple composer, durable content boundary

The initial UI accepts text. It creates the shared prompt record and compiles a
structured rendered value with ordered content parts and provenance. That content
boundary can later carry text and images without replacing session orchestration.
Destination-specific adapters lower the value into Codex input, Claude SDK content
or HP input according to actual support. Rich-part support in a type is not proof
that every destination accepts it; never silently drop unsupported content.

Keep draft editing, the submitted content snapshot and native message delivery
distinct. Target/model settings and new-turn/steer/queue intent belong beside the
content, not inside a replacement prompt editor's hidden behavior. The richer
editor and acquisition workflows will be self-contained disposable experiments;
no image-authoring or elaborate inspector UI is an S1/S5 completion gate.

## Governing decisions already established

| Direction | How it constrains construction | Evidence / requirements owner |
| --- | --- | --- |
| One trusted operator and network | Native config, easy explicit auth reuse, all-interface defaults, no mandatory grant/expiry/redaction framework. Wrong-process/path hygiene remains. | [Design principles](../../../design-principles.md), AGENTS.md. |
| One host coordinator, library composition | Foreground first, optional daemon wrapper later; no provider daemons or CLI scraping. Direct session endpoint handoff where practical. | [O21](../components/21-host-coordinator.md), [recovery sketch](../failure-recovery.md). |
| Full provider capability access | Codex native/experimental API stays available. Claude retains native data and may reuse the official SDK behind a wrapper. HP's native-shaped subset and extensions remain explicit. | [Codex spec](../../../specs/codex-client.md), [069][s069], [071][s071]. |
| Multiple clients, explicit native outcomes | No exclusive-controller lease by default. Input transport is not acceptance. Reconnect does not repeat uncertain actions. | RC-03/05/07/13; 028/068/071. |
| Claude process lifetime independent of clients | Host owns native process and byte feed; clients own SDK query/replay/callback interpretation. No host conversation Query or semantic command validator. | [068][s068], [071][s071], RC-08/13. |
| HP portable runtime and storage | Same core/history/restore code in Node/browser; host supplies execution and storage bindings. Persistence is not suspended execution. | [070][s070], RC-14, [O04](../components/04-hp-client.md). |
| Distinct history and diagnostic paths | Native history / HP archive, running Claude replay, optional debug capture and analytical ingestion have distinct purposes/coverage. | RC-09/12/13/14, [working stance](../methodology.md#develop-the-application-with-inspectable-debug-evidence). |
| Shared TypeScript computation | Reuse source-aware cost/health logic live, offline and in optional host processors. Python owns native readers/ingestion; it does not duplicate those calculations. | 033–035/061/070; [O01 comments](../components/01-client-foundation.md#your-additions). |
| Explicit intent before inference | Make target, timing/effect and observed outcome visible; later convenience inference must be inspectable and overridable. | [Methodology](../methodology.md), O09/12/14. |
| AIUI development and reusable presentation | Pure transforms → controls/cells → components → app. UI reads application-owned connections. Debug through shared UI/agent tools and source evidence. Improve young AIUI upstream when useful. | [O20](../components/20-component-lab.md), [visual direction](../visual-direction.md). |
| Practical failure recovery | Accept reported data/execution loss where necessary; use explicit native history/HP archive continuation. PID survival is not endpoint recovery. | RC-04/07/08/14, [065][s065], [recovery sketch](../failure-recovery.md). |

## Evidence that changes the design

- **056/057:** ordinary Codex inactivity depends on attachment and native settings.
  Background terminals can die on unload. Hence connection ownership is not just
  UI housekeeping (RC-01–07).
- **058/059/064/067:** native historical views omit some live information and can
  have different identities/clocks. Preserve source coverage, selected native fork
  boundaries and unsent drafts; do not use resume to enrich a historical display.
- **061/070:** analytics already has a writer/schema/config owner. Source-scoped
  joins, out-of-turn compaction usage and Node-only pricing imports are concrete
  extraction tasks. Schema v5 already accepts the tested HP records; a schema bump
  is not needed merely to register that source adapter.
- **066:** setup tokens work for the tested model flows, but status/presence is
  not verified entitlement and reference changes do not refresh existing workers.
- **068/071:** persistent native Claude and official SDK reuse are compatible with
  client-side replay/callback handling. Naive SDK replay reruns callbacks; the
  WebSocket Query does not supply automatic same-object reconnection.
- **070:** real Node/browser context survives owner destruction through portable
  archive storage. Tools/jobs/queued input do not magically survive with it.
- **Current AIUI source:** `aiui-prompts` and its inspector are now portable TS
  production packages in that repository. Earlier HP probes used its old Python
  interface. Source migration and prompt fidelity must be qualified at S0/S3.

Detailed version boundaries and acceptance scenarios live in
[runtime contracts RC-01–RC-14](../../../runtime-contracts.md), the linked reports
and the [implementation plan](implementation.md). A passed spike is evidence
for a narrow operation, not a promise that all code can be copied into production.

## Coverage of the original component map

This map preserves the original discussion owners; it does not overwrite their
comments or pretend that deferred questions were answered.

| Original component | Library/application owner | First implementation stage |
| --- | --- | --- |
| O01 shared client foundation | `agent-core`; provider projections; `agent-history/analysis` | S0/S1, richer host placement S4 |
| O02 Codex client | `codex-client` | S1 |
| O03 Claude client | `claude-client` + Claude launcher | S2 |
| O04 HP client/hosts | `hp-agent` + coordinator Node adapter; browser app owner | S3 |
| O05 hosts/discovery | coordinator + `orchestrator-client` + app inventory | S1 local, S6 remote |
| O06 profiles/auth | owning launcher libraries + management jobs + UI panels | S1/S2, integrated S5 |
| O07 launch/config | coordinator operation registry + client + app actions | S1 |
| O08 overview | `agent-ui`, app working-set model, Mosaic/AIUI | S1 minimal, S5 full |
| O09 live session | provider clients + app-owned session controller + `agent-ui` | S1/S2/S3 |
| O10 transcript/tools | provider projections + `agent-ui` rich readers | S1, deepen S5 |
| O11 subagents/jobs | provider-native clients, HP core and family/job components | Native access S1–S3, full UI S5 |
| O12 prompting | current AIUI prompt core + provider lowering + text placeholder; later inspector/editor | Minimal seam S0/S1, simple S5; rich authoring in a separate disposable lane |
| O13 voice/screen/pencil | public AIUI acquisition packages + later composer | Separate side experiments; integrate only after review |
| O14 history/branching | native helper/client paths, HP history, UI/navigation refs | S1–S3, integrated S5 |
| O15 observation/health | launcher processors, shared TS analysis, optional exporters | S1 limited, S4/S5 |
| O16 ingestion/statistics | Python history writer, TS SQL/query adapters and UI | S4/S5 |
| O17 files/commands | qualified provider operations or coordinator host-workspace adapter + source/terminal components | Read-only source S1, stream/control S5 |
| O18 environments/recovery | Hostfork + coordinator adapter + explicit recovery workflows | S6 |
| O19 application shell | `apps/orchestrator` composition | S0/S1 then S5 |
| O20 reusable UI/lab | `agent-ui`, private lab, public AIUI tools/source linking | S0 onward |
| O21 coordinator | `pdum.orchestrator` + `orchestrator-client` | S0/S1 onward |
| O22 dev/delivery | private instance supervisor and app host adapters | S0, Electron S6 |

## Source and review provenance

This is a design-only review of the current working tree on repository HEAD
`1e897c3bebb9bb6a958018b288cdc86e55c6d60a`; numerous cited spike files are uncommitted.
AIUI source was read through `.dev/aiui`, clean checkout
`e17191ff19447121882b19de890739cc8b9f6835`, with package versions `0.23.0+dev`.
The catalog distinguishes public packages from experimental/internal scaffolding.
No dependency upgrade or upstream edit occurred during this design turn.

Backend and client/UI documents were drafted in separate lanes, then reviewed
against the library map and stage dependencies. New provider inference spend:
**USD 0**. Document checks are not runtime compatibility tests. The user subsequently
accepted the library boundaries and supplied the D1–D10 guidance recorded above;
production implementation is still pending. Publication/release execution remains
human-owned.

[s065]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md
[s068]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md
[s069]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md
[s070]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/070-hp-backend-parity.md
[s071]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/071-claude-sdk-replay.md
