# Authentication study: review and handoff

**24 October 2026.** The user reviewed the revised authentication study and said
it makes sense and would work well. The interaction direction is accepted for
this mock. The visual presentation remains provisional: make it more consistent
with the other orchestrator mocks and probably denser in a later pass. This
feedback does not settle the open backend policies or authorize live auth work.

## What was unclear in the original version

The original screen emphasized credential ownership, native command previews,
status evidence and manually advancing simulated responses. Those were useful
engineering findings, but the user could not easily see the ordinary task being
represented. Too much explanatory text occupied the application surface.

The intended task is: **find a profile on a machine, see who uses it, authenticate
it, and return to the profile.** A mock should let the reviewer experience that
task through plausible application actions, including simulated browser handoffs.
It should not require the reviewer to operate a technical test harness.

Keep three surfaces distinct:

- **Application mock:** the flow the eventual operator would use. Show the target,
  meaningful choices, progress and result. Authentication belongs to a profile on
  a machine; several agents may use that profile.
- **Commentary beside it:** explain the concept, assumptions, provider differences
  and unanswered feasibility questions. This can be collapsed.
- **Study controls outside it:** inject success/failure/expiry/connection loss,
  make fixture agents idle and reset the experiment. These are review tools,
  not proposed application features.

Grounding a mock in existing launchers means preserving their configuration and
operation ownership. It does not mean presenting the CLI or implementation map
as the primary user experience. Keep that map in the notes or optional inspection.
This lesson is now recorded in the orchestrator working methodology.

## What changed

- Seven stable profiles across two machines, with provider identity, agents using
  each profile, activity and authentication indicators. Expiry can be known,
  expired or unknown; the displayed values are fixtures.
- Choosing an authentication method keeps the profile identity fixed. An attempt
  retains its target even if the selection behind it changes.
- Guided account sign-in, API-key reference and existing-login reuse journeys.
  The remote journey opens a fictional sign-in window in this page and returns
  to the target profile. It does not contact a provider.
- Separate exploratory Workforce Federation and Bedrock profiles. The Bedrock
  sketch offers AWS SSO or a machine role.
- Explicit illustrative “Continue now” and “Wait for idle” choices when agents
  are working. The latter advances through a study event; background work remains
  visible after agents become idle. Neither option is an agreed live policy.
- Success returns to the profile. Optional model-access validation is separate
  from authentication evidence. Failure and lost remote observation preserve
  uncertainty instead of implying completion or automatic retry.
- Commentary, open questions and study controls now sit outside the main flow.

## Carry forward

Preserve the revised task flow when making the display denser and visually closer
to the other mocks. The user liked the conceptual organization; there is no need
to recreate the original technical inspection screen.

Before live implementation, investigate authentication during active work,
credential pickup by existing workers, what “idle” should mean, per-provider
remote sign-in, reliable expiry/refresh information, and cancellation/reconnection.
Workforce Federation and Bedrock need their own provider/configuration mapping.
The existing Codex AWS **workload** federation helper is a different mechanism.
These questions and their needed-by triggers are in the [README](README.md#questions-to-carry-forward).

The UI remains disposable, source-linked Solid/AIUI code. No credentials were
read, profiles written, login processes launched or provider calls made. The
current flow lives in `src/model/journey.ts`, `store.ts`, `graph.ts` and
`src/ui/App.tsx`; `auth.ts` retains the earlier source-inspected operation map.
Do not infer provider support from successful fixture interactions.

Validation recorded for the rewrite: 15 model/graph/source-map tests, 62 browser
assertions at desktop and three phone widths, UI/keyboard and HMR checks,
TypeScript, Vite build and strict MkDocs build. Build limitations and reproduction
are in the README. These were implementation checks, not live auth qualification.

Open the study at `http://localhost:56044/auth/` while the shared server is running.
The [report](../../docs/spikes/060-authentication-flows.md) summarizes the result;
the [round tracker](../../../docs/plans/agent-orchestrator/next-mock-rounds.md)
records the interaction review. Other historical-viewer work is happening in the
same checkout; preserve those unrelated changes. This session made no commit.
