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

## Review the slice before widening it

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
