# Next orchestrator mock rounds

**Agreed sequence, 19 October 2026.** This is the progress tracker for the next
eight spikes. Round A starts now; review its history/rendering experience and
authentication study before widening into Round B. Round C integrates the
reviewed pieces. These remain disposable studies, not production SDK contracts.

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
- Independent agents own separate folders and reports. Small copies are allowed;
  extraction into reusable packages waits for evidence. The coordinator owns
  shared host, dependency, navigation and plan edits.

## Configuration owners to consult

| Area | Existing owner / source | Mock obligation |
| --- | --- | --- |
| Ingestion | `packages/agent-history/src/pdum/agent_history/config.py`, `sync.py`, `cli.py`; [history guide](../../agent-history.md) | Represent `history.yaml`, its Codex/Claude/profile sources, existing target options, window and blob settings. Preserve supported defaults and target credential references. |
| Codex profiles/config | `packages/codex-launcher/src/pdum/codex_launcher/profiles.py`, `config.py`, `cli.py`; [profile guide](../../profiles.md) | A profile is a Codex home. Keep native TOML/unknown fields; distinguish explicit edits from launch-time overrides. |
| Codex authentication | `packages/codex-launcher/src/pdum/codex_launcher/authentication.py` and mounted CLI | Preview the existing login/reuse/API-key operations and their actual supported parameters. |
| Claude profiles/auth | `packages/claude-launcher/src/pdum/claude_launcher/profiles.py`, `authentication.py`, `cli.py`; [Claude guide](../../claude.md) | Preserve native Claude profile layout and existing authentication strategies; official clients own conversation queries. |
| History access | Existing Claude management helpers, official SDK history functions, and Codex history methods qualified in spikes 025–034 / runtime contracts | Prefer existing adapters; retain native payloads. No private recovery-format reconstruction or silent resume. |
| Host coordination | [O21](components/21-host-coordinator.md), existing launcher libraries | The unified coordinator remains proposed. Do not present a mock endpoint as an implemented host protocol. |

## Tracker

IDs use new folders after the existing 057 lifecycle follow-up. Status values are
**queued**, **in progress**, **ready for review**, and **reviewed**. Validation
results and links belong in the row before a slice becomes ready for review.

| Round | Spike | Visible result / question | Integration | Status |
| --- | --- | --- | --- | --- |
| A | 058 — Native history access | Read real Codex/Claude sessions through native history surfaces without activating work. Record exactly what is available. | Disposable read adapter/export consumed by 059; no DuckDB dependency. | Ready for review — 16 real sessions, four Python and two Node checks; empty loaded registry and unchanged source transcripts. |
| A | 059 — Rich historical viewer | Render messages, tools, children, Markdown/code/math/Mermaid/images and trustworthy usage attribution from native records. | New read-only study beside 054, borrowing its useful layout/navigation. | Ready for review — nine adapter/cell tests, 23 browser checks at desktop and phone widths; real captures and a labelled rich-content specimen. |
| A | 060 — Authentication flows | Explore Codex/Claude login, existing-login reuse and API-key strategies on local/remote hosts, including failure/cancel/expiry. | Independent mock, operation previews grounded in launcher source. | Ready for review — 15 model/cell tests, 41 browser checks; operation map verified against existing source/CLI. |
| B | 061 — Ingestion and statistics | Configure the actual ingestor, inspect progress/coverage/errors, and query useful aggregates in DuckDB. | Independent statistical study; later links into 059. | Queued — after A review |
| B | 062 — Launcher connections | Connect to local/remote launchers, discover managed profiles/tasks, and understand disconnect/reconnect and execution location. | Independent management study. | Queued — after A review |
| B | 063 — Profile workbench | Create from a base or scratch, edit provider-native configuration, compare defaults and launch overrides. | Existing profile/config operations represented in an independent view. | Queued — after A review |
| C | 064 — Find and prepare continuation | Follow a statistical finding to native history, choose a session/point, and prepare an explicitly simulated resume/fork and draft. | Connect 059/061; preserve session/turn/item identity and draft intent. | Queued — after B review |
| C | 065 — Task launch and shutdown | Choose host/profile/cwd/prompt/settings; distinguish interrupt, end runtime, archive and stop server, including dependent work. | Connect management studies to overview/session mocks. | Queued — after B review |

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
   detached simulation. Preview real operation names and locations; simulate
   login responses. Do not read credentials, launch login, write profiles or
   start workers merely by opening the mock.

The temporary exchange is a local catalogue plus provider-labelled native
documents: provider, native session ID, source/method, capture time and raw payload.
It is a mock transport envelope, not a new persisted agent-history schema or SDK.
Provider-specific rendering adapters may retain different fields. Cross-view
links need only preserve provider/source/session/turn/item identity for now.

Within each lane, work in AIUI's order: **pure adapters and accounting → controls,
durable state and cells → components → reviewable application/tool surface**.
Keep interpretation tests near pure adapters; use real local API reads and browser
checks for integration. HMR, phone layout and keyboard behavior are separate checks.

## Review gates and deferred questions

| Needed when | Questions to resolve / evidence to review |
| --- | --- |
| A review | Is the real-history layout useful? Which native gaps matter? Is read-only unmistakable? Does auth make provider, profile, host and credential location clear? |
| Before B ingestion implementation | Which existing sources/targets and configuration operations should the first usable UI expose? Which ingestion failures need operator action? |
| Before B profiles/connections | Which native profile operations are most valuable; how should base copying and remote host selection appear? No implicit new inheritance scheme. |
| Before C | Choose resume/fork point semantics, draft handling, cross-view navigation, and effects of task/server shutdown. Refer to RC-01–RC-08. |
| Before live control | Qualify actual login/cancellation/renewal and operator-assisted remote flows; distinguish simulation from real operations. Existing authorization is not replaced by repeated confirmation screens. |

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
- Round B/C remain queued for their agreed review checkpoints.

### Round A review links

The lab exposes `/history/` and `/auth/`, with per-study Markdown notes. Existing
overview and conversation mocks remain available alongside them. From the
repository, read the reports at `experiments/docs/spikes/058-native-history-access.md`,
`059-historical-viewer.md` and `060-authentication-flows.md`; reproduction and
operation mappings are in the matching spike folders.

Review the historical rendering/coverage first, then the authentication ownership
strip and separated outcomes. The main open questions are presentation and
workflow preferences; backend configuration owners have not changed. New provider
inference spend for Round A is zero; original captured-session usage and assistant
implementation effort are separate.
