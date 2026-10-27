# 060 — Sign in a profile on a machine

**24 October 2026 · Round A revision · disposable interaction mock.** The user
question is “How do I make this profile ready to use?” The first version focused
on native operation previews, ownership and response evidence. Review found the
purpose unclear: the engineering explanation occupied the place where an ordinary
sign-in journey should have been.

**User feedback after the revision:** the flow now makes sense and would work
well. Preserve this interaction direction. A later styling pass should bring it
closer to the other mocks and probably make the information denser. This is an
interaction review, not a final visual specification or a decision on live auth
policies. The [handoff note](../../spikes/060-authentication-flows/HANDOFF.md)
records the changes and guidance for the original implementation agent.

The revised direction starts with **machines → profiles → agents using each
profile**. Seven fixed profiles across a local and remote machine show agent
activity and separate authentication state, including illustrative known,
expired and unknown credential lifetimes. Choosing another sign-in method keeps
the profile identity fixed. The operator can follow a browser sign-in journey,
select an API-key reference, or reuse an existing login. A local simulated
provider page explores how signing a remote profile in from this browser could
feel. Separate organization and Bedrock profiles expose exploratory Workforce
Federation and AWS credential-source journeys.

Commentary sits beside the proposed application and explains the concept and
unresolved questions. Scenario controls, technical operation mappings and test
machinery belong to that study layer. The interaction itself should remain
understandable without reading an implementation report.

Running agents make the timing question visible. “Continue now” and “Wait for
idle” are explicit alternatives to explore, with a study control that can move
fixture agents to idle. This is not a chosen scheduling policy. An idle agent may
still own background work, and the mock does not establish whether reauthentication
interrupts a request, changes credentials for a live worker, or requires relaunch.

The [operation map and question register](../../spikes/060-authentication-flows/README.md)
retain existing launcher ownership. Codex existing-login reuse is currently a
creation-time `auth.json` snapshot; Claude reuse borrows an access token without
managing refresh. Codex also has an AWS **workload** federation helper for OpenAI
API access, with live exchange and renewal still unqualified. That is distinct
from human **Workforce Federation** and Bedrock. Claude launcher Bedrock/federation
adapters are not implemented. The conceptual UI introduces no replacement native
configuration schema or new supported CLI operation.

Before live work, answer how each native provider completes sign-in on a remote
machine; what expiry information is reliable and renewable; when running agents
notice changed credentials; what “idle” would mean across several agents and
jobs; and what cancellation, reconnection and retry can confirm. The README
records each question's owner and needed-by trigger. These remain open while the
user evaluates the mock. RC-01/RC-04 preserve the distinction between idle and
no dependent work; RC-07/RC-08 preserve unknown outcomes and provider-specific
semantics. See the [runtime contracts](../../../docs/runtime-contracts.md).

Run from `experiments/` with
`node spikes/055-orchestrator-mock-lab/serve.mjs` and open `/auth/` (also
`/060-authentication-flows/`). The view remains Solid/AIUI with durable controls,
cells and the Habemus Papadum design system. The surface is entirely simulated:
no credential reads, profile writes, native login, model calls or real remote
handoff. Authentication status and expiry values are fixtures.

**Evidence boundary:** the 19 October version passed 15 model/cell tests and 41
browser checks, plus type, keyboard, HMR and phone/desktop layout checks. Those
results describe the earlier interface, not this rewrite or provider compatibility.
Its environment and detailed results remain in the README and Git history. The 24 October revision passed 15 model/graph/source-map checks and 62 browser
assertions at desktop and three phone widths. Actual buttons and keyboard handling,
component/graph HMR, type checking, the shared Vite build and strict documentation
build were checked. The clean browser run had no errors or warnings after repairing
list identity/equality diagnostics. See the README for reproduction and build
limitations. No new provider inference was performed (experiment spend USD 0;
development-agent service usage is separate). The interaction revision was
reviewed positively; visual refinement and backend questions remain open.
Round B/C remain behind their existing review gates.
