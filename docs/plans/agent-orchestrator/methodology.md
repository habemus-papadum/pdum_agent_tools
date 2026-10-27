# Working method: timely questions and explicit intent

**Agreed direction, 19 October 2026.** Apply this method before each orchestrator,
SDK or reusable-component slice. The component cards hold an inventory of useful
questions, not a questionnaire that must be answered before any work starts.
Read the [first-slice proposal](first-slices.md) for how this applies next.
For runtime/client/coordinator slices, review the applicable
[runtime contracts](../../runtime-contracts.md), cite their RC IDs in the slice
plan, and carry their regression scenarios into acceptance checks. Resolve only
the recorded policy questions that the slice now depends on. New consequential
findings belong in that canonical ledger with evidence and version boundaries.
The [visual direction](visual-direction.md) is a provisional preference record:
use Habemus Papadum's design system as the starting point, explore expressive
CSS in the mocks, and record useful upstream candidates after visual review.

## Decide which questions matter now

Before starting a slice, state its visible result, whether it is a mock, spike or
live implementation, and which component cards it touches. Read the user's
comments and previously recorded decisions. Then classify its open questions:

| Classification | How to proceed |
| --- | --- |
| Already answered | Apply the recorded guidance; do not ask again unless new evidence changes the tradeoff. |
| Explore in the mock | Show explicit alternatives or a labelled fixture assumption. Do not turn that assumption into a product default or durable API contract. |
| Technical choice delegated to the agent | Recommend/choose an implementation using source and measured evidence, explain material tradeoffs, and record the choice. Avoid asking the user to resolve routine engineering details. |
| Needs user input for this slice | Ask the smallest useful question, with the concrete behavior and consequence. Resolve it before implementing dependent behavior. Continue independent work where possible. |
| Deferred | Record the stage or condition that makes the question relevant, so it is asked when needed rather than forgotten. |

"TBD" is an acceptable outcome. If a mock can leave that behavior unimplemented
or expose alternatives, proceed with that limited scope. If a real operation
depends on it, narrow the slice or keep that operation pending instead of
silently choosing. Delegation can include "recommend, then discuss"—the O21
failure/lifetime decisions have exactly that status.

Use a small decision note with **question, current evidence, owner/status,
needed-by trigger and eventual answer**. Keep it in the relevant component or
slice plan. Batch only the questions that affect the next step; do not interview
across the whole component catalog at once. This is product/design clarification, not a
new mandatory permission workflow for already-authorized implementation.

## Make the user's intent explicit first

The initial UI should teach the important operational distinctions and let the
person select the behavior they mean. Use plain labels, visible targets and
short explanations of effects. Expose the underlying meaning that affects the
decision, with deeper protocol detail available on demand.

For example, input arriving during a turn could mean steering that turn,
delivery at a supported boundary within it, queueing a new turn, or interrupting
and replacing work. These are not interchangeable meanings of a generic Send
button. The provider may support only some of them, and its safe-boundary timing
must remain honest. Do not invent a distinct "steer after" operation where the
backend has no corresponding guarantee.

| Intent dimension | What should be explicit |
| --- | --- |
| Target | Which agent/session, current turn, future turn, job or host will be affected? |
| Timing | During the current turn at a supported boundary, after it finishes, or as new independent work? |
| Scope/effect | Observe, change input, interrupt, stop a job, stop a subtree, close an owner, or change saved defaults? |
| Outcome | What was requested, what was accepted, what is queued, and what execution/delivery has actually been confirmed? |

A visible selected mode with an accurately labelled action can express intent;
explicitness does not require a modal or another confirmation on every click.
Keyboard shortcuts and agent-facing tools should dispatch the same semantic
actions as buttons. If state changes between selection and dispatch—for example,
the targeted turn ends—show that outcome rather than silently changing the
operation into a new-turn submission.

Apply the pattern throughout the product: read history versus resume; clone
conversation versus restore files; cancel a wait versus stop its producer;
close a view versus stop its owner; edit profile defaults versus override one
run; inspect a current file versus a historical captured artifact.

## Add inference later, and make it inspectable

**26 October review:** contextual launch defaults are an approved convenience
now. Starting an agent from a project/host/directory view uses that context;
show where the values came from and keep review/override easy. This does not
infer turn delivery intent. Working model/effort/tier overrides carry forward
within the conversation, while saving global/profile defaults remains a distinct
explicit action. Do not let a remembered unrelated launch override the current
action context. See [D2](system/decisions.md#context-overrides-and-worktrees).

After explicit workflows have been used and reviewed, introduce conservative
conveniences that infer a likely intent. Preserve an easy explicit override and
show the selected behavior where it matters. Distinguish a remembered explicit
setting, a declared default and a system inference.

A useful action record would include the selected operation/target, whether it
was explicit/defaulted/inferred, the rule or reason used, any override and the
observed outcome. The exact schema is not decided here. It should support both
human inspection and an agent debugging the system without forcing a raw JSON
panel into ordinary interaction. A system-inferred action must not be described
later as an explicit user request.

Existing agreed defaults remain valid—for example, ending a superseded AIUI
observation with a clear outcome. New defaults that materially change execution
need their own decision; they do not arise accidentally from a mock's wiring.

## Build one thin slice at a time

Default to one small slice and a review before widening it. The user explicitly
requested two independent throwaway mocks on 19 October, so that round runs in
parallel with separate folders and a Markdown note per study. This supersedes
the earlier sequential-only choice for these disposable studies; it does not
freeze shared production APIs or authorize unbounded parallel work. Further
parallel implementation is useful once shared boundaries and ownership are
clear; this method is not a request to spawn agents by itself.

Each mock delivers a runnable web page and a short account of the interaction
it explores, what is simulated, open questions and useful ideas to carry forward.
After enough review, use those notes to write a concrete specification; do not
promote disposable mock code into production merely because it already exists.

Configuration screens begin from the owning tool's existing config, CLI and
library operations. Record how each UI choice maps to that owner. Ingestion
config belongs to the ingestor; provider profiles, authentication and native
settings belong to their launchers/providers. A mock may explore an unsupported
step explicitly, but must not silently establish a replacement configuration
schema. Temporary form state and transport envelopes are not new durable contracts.

Follow AIUI's dependency order within every slice, without building an entire
framework before anything is visible:

1. **Pure functions:** transforms, identities, action meanings and test scenarios.
2. **Controls and cells:** declared inputs/actions, asynchronous boundaries and
   explicit resource ownership; keep SDK logic framework-independent.
3. **Components:** render those states and actions, including uncertainty/errors.
4. **Application:** compose one reviewable interaction and drive it through the
   same tool/action surface used by the UI.

Use behavioural checks appropriate to each layer and human visual review early.
Fixtures demonstrate interactions and fault cases; they are labelled and do not
establish provider compatibility. Live slices require real endpoint evidence.
Source-link/HMR behaviour is separate from persistence across page or process
loss. Keep dependencies local to actual consumers and improve upstream AIUI
pieces when they are the right owner.

## Make a mock a walkthrough of the user task

**Working-application clarification, 24 October 2026.** For Round B onward,
disposable means that the implementation may be replaced, not that the experience
should run on invented data. Prefer real local data, existing tool operations and
working end-to-end flows. Use synthetic cases when they answer a particular
interaction question or cover missing evidence, and label them separately.
Keep new writable state in an explicit lab location; ordinary profiles and
history remain unchanged. Preserve existing configuration ownership.

Optimize for learning from the application before selecting production package
boundaries or a comprehensive testing strategy. Validate the actual journey,
important data claims and consequential write/cleanup behavior. Avoid broad test
scaffolding or abstraction work just to make disposable code look finished.
Keep presentation dense and make unavailable operations explicit instead of
substituting a successful fixture response.

**Clarified in authentication review, 24 October 2026.** Begin with the ordinary
entry point and the outcome the operator wants: for example, find a profile on a
machine, sign it in, and return to the agents using it. Let the person experience
that journey through the proposed application's own labels and actions. A mock
can simulate a provider page or a remote result without implementing the service.

Keep three surfaces distinct:

- **Application:** the choices, progress and results the eventual user would see.
  Show details that affect the user's decision, including the target and timing.
- **Commentary:** a separate side pane or notes explaining the concept, why a
  choice exists and its mapping to existing infrastructure.
- **Study controls and open questions:** fixture outcomes, manual response
  advancement, reset and unanswered feasibility questions. These belong outside
  the application surface, with a needed-by trigger for each unresolved question.

Grounding a mock in real launcher/configuration code does not require displaying
the code's mechanics throughout the main flow. Keep the operation map in the
Markdown or an optional inspection view. Clearly mark conceptual paths and
synthetic status; a polished success screen is not evidence that the backend can
perform the operation.

Explore unresolved alternatives without silently deciding policy. For example,
reauthentication “now” versus “after idle” may be illustrated while the effects
on shared-profile agents remain unknown. Record that uncertainty beside the mock;
do not turn the illustrative choice into a runtime default. Preserve the identity
of the thing being acted on across a flow, even when its settings change.

## Develop the application with inspectable debug evidence

**Working stance clarified by the user, 25 October 2026.** Ordinary historical
conversation browsing uses provider-native history. We are not requiring a second
persisted history assembled from live-only events. DuckDB ingestion/statistics
remains its own existing data path. Live measurements may be useful while a
session runs without becoming fields that every later historical view must recover.

Development captures have a different purpose: help the operator and an agent
understand a wrong-looking message, an unclassified event or a UI problem while
using the application. A Vite development instance reachable through the session's
DevTools MCP and AIUI tools is the expected working environment. Debug capture may
retain unfamiliar records, a broader event stream, or a complete selected history
snapshot for reproduction. It may default on during early development and should
be visibly controllable. This is a direction for the development workflow, not a
claim that a debug toggle or durable diagnostic service is already implemented.

Keep the feedback loop short:

1. The operator identifies a message, selection, interaction or region that looks wrong.
2. The agent uses AIUI report, selection, source/locate and application tools, plus
   DevTools, to inspect the same instance, rendered state and available native evidence.
3. Relate the displayed item to its source record and current adapter interpretation;
   expose unclassified records and capture gaps rather than silently guessing.
4. Improve the projection, component or upstream AIUI primitive, then reproduce
   the problem with captured input when possible. Replay for diagnosis does not
   rerun provider tools or model calls.
5. Recheck the actual page and preserve the useful learning in the owning notes.

Leave practical hooks for that loop as the backend/client infrastructure is
built. Candidate diagnostic context includes instance/provider/version, native
identities, receipt sequence/time, original record, interpretation and selected
controls/actions. Let usage reveal the useful shape; this is not a frozen capture
schema, a full event-store architecture or a requirement to finish a generic
debugger first. Captures stay distinguishable from native history and local raw
evidence stays ignored. Recording failures/gaps remain visible and observation
must not block provider traffic, as required by the existing runtime contracts.

AIUI is part of how we develop the product while using it. Its controls, cells,
tool surface and source linking should make incremental refinement practical.
We can change the young framework upstream where that is the right owner; the
entire UI/protocol vocabulary need not be settled before the first useful app.

## Stop expanding mocks when the architectural questions are answerable

**25 October clarification:** the running-session journal proposed for Claude in
[068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
serves attachment and replay while that process lives. It is a functional part
of that proposed transport, distinct from optional development captures and from
ordinary native history. Its retention need not extend beyond process exit.
Do not turn either diagnostic capture or this journal into a mandatory replacement
for native historical storage. Recording stdin establishes input transport
evidence; only native output can establish the provider's reported outcome.

The mocks establish the broad interaction scope, source differences and important
ownership boundaries. They do not need to exhaust every message type, polish
every visual or qualify every advanced feature before architecture work begins.
Complete the remaining focused studies in [the round plan](next-mock-rounds.md),
then consolidate a reviewable backend architecture and browser/Node client
interface. Carry unresolved details as explicit extension points or qualification
items with a needed-by trigger. Do not convert every observed gap into another
prerequisite mock or promote throwaway code merely because it already works.

## Review the slice before widening it

### Preserve evolving data knowledge

Keep native schema/availability findings in a versioned Markdown ledger alongside
the mock, such as [059's availability ledger](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-data-availability.md).
Record observed fields, missing or uncollected data, interpretation basis, actor,
producer/reader/adapter versions and links to evidence/regressions. Unknown native
fields should remain inspectable while their meaning is investigated. A mock's
temporary interfaces and successful examples are not a complete production schema.
Use the ledger when extracting SDK types, preserving uncertainty and source scope
instead of freezing assumptions that merely made the first rendering convenient.

Report what the user can now do, which semantics were explicit, what was inferred
(initially usually nothing), which questions were answered/deferred, and what
the tests establish. Ask for feedback on the experience rather than requesting
approval for every routine implementation choice.

Review data cost as well as visual density. A cheap sign of activity, a useful
summary and a deep forensic view are different workloads. Rendering less detail
does not automatically mean less data was fetched or parsed. Measure where
computation happens before freezing coordinator/client/storage boundaries.
Keep ordinary source capture independent of view filtering and report real loss.

Preserve the user's original component comments. Add linked summaries to the
right owners when a comment spans several components; absence of an answer is
not consent to a guessed policy.
