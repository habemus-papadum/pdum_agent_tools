# First slices: overview, then session interaction

**Proposal after the user's component review, 19 October 2026.** This records
what the comments change and originally recommended a sequential start. The user
subsequently authorized two parallel disposable mocks; both studies now exist,
with web pages and essence Markdown. See the [mock runbook](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/055-orchestrator-mock-lab/README.md).
This does not resolve the questions deliberately left open. Use the
[working method](methodology.md) before taking each slice into code.

## Guidance carried forward

| User guidance | Where it belongs |
| --- | --- |
| Provide the kind of high-level information in native agent browsers, plus context percentage, estimated price and status. Rich cards/icons are plausible; a row layout is not required. | [O08 overview](components/08-agent-overview.md), with evidence/availability from O01/O15. |
| Decide where information is computed and fetched through evidence about latency and cost, not through presentation choices. A common field may still require a provider client call. | [O01 mechanics](components/01-client-foundation.md), O15/O16 and [O21 coordinator](components/21-host-coordinator.md). |
| Support a cheap sign of activity, a quick sanity-check view and deeper inspection down to raw JSON for humans and debugging agents. | [O10 rendering](components/10-transcript-tools.md), O08/O15; detailed evidence need not be loaded/rendered continuously. |
| Start around 30–40 agents, including familiar long-lived agents and short-lived consultants; eventually inspect thousands of workers primarily in aggregate. | O05/O08/O21, with explicit scaling measurements rather than thousands of live model runs. These are use patterns, not mandatory new agent classes. |
| Browser HP agents initially run inside this UI as local facilitation/testing. They are not remotely administered or implicitly shared across tabs. Future browser-local coordination and history behaviour are unresolved. | [O04 HP](components/04-hp-client.md), O05/O19 and the reusable component lab. |
| Session file links should resolve with their working-directory/host meaning, open a read-only source view, support comments, and let selected code feed a prompt. | [O17 files](components/17-files-commands.md), O10 and [O12 composer](components/12-prompt-composer.md). |
| Recommend coordinator lifetime/recovery choices from the subcomponents, then discuss them; launcher changes are possible. | O21 and the [recovery sketch](failure-recovery.md). This delegates investigation, not a silent final lifecycle decision. |
| Make intent explicit first, then add visible, overridable inference after experience. | The [methodology](methodology.md), all UI actions and their SDK representations. |

Original comments remain in their component cards. Unanswered questions remain
open; review of a card does not imply an answer. Claude ownership/discovery
questions are explicitly deferred. Choice of useful initial Codex operations is delegated
to implementation judgment within these boundaries.

## Slice A — One overview and detail mock

**Throwaway study now available; user review pending.** Show
one coherent screen for finding an agent, understanding whether it needs
attention and opening detail. Include Codex, Claude, HP Node and a clearly local
browser HP example from the beginning.

| AIUI layer | Narrow deliverable |
| --- | --- |
| Pure functions | Representative agent summaries with provider/host/profile identity, activity, context and cost coverage, freshness and filter/group transforms. Unknown context/cost remains unknown. |
| Controls and cells | Explicit filters, selected agent, detail level and scripted activity/error/stale scenarios. Mock data ownership is independent of layout. |
| Components | One information-rich overview candidate, with a modest density/arrangement alternative where useful; a selected-agent panel with activity, summary and inspectable evidence. |
| Application | Open/filter/select/drill down and return without losing position. Mark fixtures clearly. The interface does not create provider sessions to obtain overview data. |

Use 30–40 representative fixture entries to explore density and filtering. A
synthetic thousand-entry scenario can measure UI work later; it does not prove
backend scalability. Begin with the cheap overview and load deeper fixture
details on demand so the separation is visible without freezing an API design.

**Questions to explore in the mock:** cards versus rows, which summary facts
deserve space, and the transitions between activity/summary/raw detail. These
need not be answered before the first pixels. Show a concrete candidate instead
of requesting preferences about an abstract layout.

**Deferred:** discovery refresh policy, exact data sources, daemon shutdown,
Claude connection lifetime, persistence and browser cross-tab behaviour. The
mock must not quietly establish these policies. No live actions, media capture,
automatic remediation or new unified provider abstraction is needed here.

**Review point:** can the user scan their agents, distinguish unknown/stale from
healthy/working, find the relevant one, and obtain progressively deeper evidence?
The next slice should incorporate that feedback.

## Slice B — Session, file reference and explicit submission mock

The user requested this second disposable study alongside A. Both share one
preview host while retaining independent fixture state and notes; review them
before choosing shared production abstractions. Explore a session interaction with a file reference
and a draft prompt; this connects the user's concrete O17 request to the SDK's
control semantics.

| AIUI layer | Narrow deliverable |
| --- | --- |
| Pure functions | Timeline/action fixtures, target/turn identity, file-reference resolution and code-selection provenance. Preserve the working directory associated with the reference, not just the host's current directory. |
| Controls and cells | Selected transcript item/file, explicit current-versus-captured source choice where relevant, local draft comments, selected code and a visible submission mode. |
| Components | Transcript with meaningful file links, a read-only source viewer, temporary commenting/selection and a composer showing the chosen action and target. |
| Application | Open a link, inspect/select/comment on code, add it to the draft, choose how the prompt enters the conversation, then inspect the scripted acknowledgement/outcome. |

Offer only actions whose meaning is stated. Illustrate steering an active turn,
queueing a new turn, and interruption/replacement as distinct intents where a
provider supports them. Delivery timing follows the provider; a mock must not
invent an upstream "steer after" guarantee. Show a turn ending before dispatch,
unsupported action, or uncertain acknowledgement without silently reinterpreting
the user's choice. No inferred submission mode is needed in this first version.

The file viewer edits no source files. Mock comments and selections are local,
temporary state until their persistence/anchoring is designed. A link may refer
to current host bytes or retained historical evidence; that difference must be
visible. Missing/changing files should have their own scenarios, not a fallback
to an unrelated local path.

**Ask when needed:** before real persistence, decide comment anchoring/storage;
before live queue semantics not covered by native APIs, discuss the proposed
placement and observable effect. The explicit modes can be explored in a mock
without prematurely choosing one universal default.

**Review point:** does the user understand what will be sent, to which agent/
turn, when, and which file content it includes? Can a debugging agent inspect
the same requested-versus-observed action record?

## Focused investigations before committing live boundaries

The user requested recommendations on information placement. These investigations
support that recommendation; they are not a new broad parity programme or work
to run concurrently with the initial mock by default.

| Investigation | What to inspect/measure | Decision it informs |
| --- | --- | --- |
| **Where each fact is available** | For activity, pending input, model/settings, usage/cost, context percentage, child/job counts and raw tool detail, inspect existing tap/history evidence and supported read APIs. Record source, coverage, freshness, required calls and provider differences. Do not activate a session merely to populate a summary. | Which facts can be materialized at the coordinator, which require a direct provider query, and which come from history/query storage. Common versus provider-specific is a separate axis from data source. |
| **Cost of ordinary overview versus investigation** | Replay representative events through shared projections; compare summary updates and on-demand detail at 40 and 1,000 simulated agents. Measure update latency, bytes transferred, parsing/CPU, memory, rendering and query fan-out. Distinguish UI-only simulation from actual backend evidence. | Incremental summaries, push/poll boundaries, detail fetching and shared computation placement. Display coalescing/paging must not silently truncate source capture. |
| **Lifetime and evidence gaps** | Follow the coordinator recovery sketch using one provider at a time. Observe which taps/endpoints survive, what stops updating when the UI leaves, and how saved history fills or fails to fill the gap. | A recommended ownership/recovery policy to discuss before promising it in the live system. |

The hypothesis to test is a coordinator with cheap incremental summaries,
provider SDKs for selected live/detail operations, and history/analytical stores
for deeper queries. It is not yet a binding partition. Context percentages need
an identified numerator/denominator and cost needs dated pricing/coverage;
unknowns must not become apparently comparable precise values.

## First live slice after those reviews

Use the reviewed overview/session components with the minimum Codex client and
foreground coordinator functionality they need, plus a Node client example.
Codex is the proposed first backend because the existing C1/C2 baseline and
native protocol evidence give a concrete path; this is sequencing, not a common
API designed to exclude Claude or HP. Keep their capabilities in the mock data
and qualify them in subsequent real slices.

Before changing launcher ownership, present the recommendation and remaining
loss/recovery tradeoffs to the user. Before the first live Claude integration,
ask its deferred discovery/connection-lifetime questions. A local browser HP
test uses only the app's own session and application tools; remote administration,
cross-tab sharing and persistence are not implied. Native process/file tools
belong to explicit host adapters.

## Questions and their next useful moment

| Question | Current treatment | Ask or resolve by |
| --- | --- | --- |
| Overview form and density | Explore in Slice A; no fixed row layout. | Review the actual mock. |
| Useful initial native controls | Delegated choice, with explicit meanings and capabilities. | Explain chosen scope before Slice B/live implementation. |
| Where facts are computed/fetched | Agent investigates and recommends. | Before fixing management/SDK summary contracts. |
| What an active-turn submission means | User-selected mode first; no hidden inference. | Ask about unsupported/new queue semantics before wiring them live. |
| File comments, anchoring and retained selections | Temporary fixtures in B. | Before storing real annotations or claiming historical file identity. |
| Browser HP reload/history and same-browser coordination | Current session only; no remote administration or implicit cross-tab sharing. | Before implementing persistence or tab coordination. |
| Claude discovered-session and owning-client behaviour | Explicitly deferred by the user. | First real Claude workflow using those choices. |
| Coordinator exit/crash policy | Agent recommends from internals, then discusses. | Before changing existing lifetimes or offering daemon/survival modes. |
| Parallel mocks/work streams | Two independent throwaway mocks explicitly authorized and built. | Review before broadening; production parallelism still needs shared boundaries and ownership. |

The current implementation is fixture-only HTML/JavaScript under experiments,
with no new production package or provider calls. The next step is to review
both pages and their Markdown, revise the interactions, then use those findings
to form a concrete spec. [Development and delivery](development-flow.md) is a
separate open entry; browser/Electron decisions do not gate these mocks.
