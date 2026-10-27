# 067 — Owned live sessions and native history

**25 October 2026 — working browser study, ready for review.** This study launches new Codex
and Claude conversations through existing launcher libraries, using separate lab
profiles and the operator's selected working directory. It does not discover or
attach to unrelated running sessions. The later [064 continuation](064-history-continuation.md)
and [065 lifecycle](065-session-lifecycle.md) studies now extend this same page.

The visible target is a compact browser prompt/conversation workspace whose live,
saved-history and comparison views use the same presentation. Native records,
source identity and unavailable fields remain available for inspection. The
question is how much rendering can be shared across vendors and live/history,
without pretending their message protocols or lifecycle semantics are identical.

Open [the live workspace](http://localhost:56044/session-lab/). Choose a provider
and working directory, launch, and send a prompt. After a turn, **Read saved
history** and **Compare** show the same conversation through both sources. **End
runtime** stops the owned runtime; the native snapshot remains readable. The
[runbook](../../spikes/067-live-session-workspace/README.md) describes ownership,
authentication and setup.

## What the real runs showed

Both providers read the lab's real `sample.txt` through a tool and correctly
reported its marker and three apples. Both ended cleanly, and their saved native
history was available before and after ending. No ordinary profile or external
session was adopted. The selected user/tool/assistant content matched exactly
between the live and saved projections in both cases.

| Source | Live view | Saved view | Practical difference |
| --- | --- | --- | --- |
| Codex 0.164.0 / requested `gpt-6-luna` | 40 wire records; three conversation/tool items plus seven protocol records | Three native items, with the same three item IDs | Live usage/context notifications are absent from this history projection. Command input/output is one operation. |
| Claude Code 2.1.310 / `haiku` resolved to `claude-haiku-5-5` | 44 SDK/local records; four conversation/tool blocks plus three command-lifecycle records | Four blocks through Python SDK 0.2.165 | Tool use/result are separate. Token counters agree, but saved messages omit live SDK cost and model capacity. Wrapper UUIDs differ from model-response IDs. |

The official browser SDK was **0.3.296**. Codex used its existing launcher relay
and native JSON-RPC. Claude's browser SDK owned the live query; Python only owned
profiles, workers, transport and native history helpers.

The extra protocol records belong in optional inspection. They are not lost
conversation content in history. The UI now folds them into a separate section,
while preserving full data and counts. It also labels input counters differently:
Codex input includes cached tokens; Claude input here means uncached tokens, with
cache read/creation separate. A shared label with different arithmetic would be
misleading. See [projection evidence](../../spikes/067-live-session-workspace/projection-notes.md).

## Implication for later architecture

**User clarification after review, 25 October:** native history remains the
ordinary historical source. Keeping live-only data for later history is not a
product requirement. The local captures used here are development evidence: an
operator can point out an unfamiliar message or UI problem and an agent can
inspect/reproduce it through DevTools and AIUI. A future debug mode may retain
uncategorized records, a broader stream or a complete selected history, and may
default on early in development. The current capture hooks are a starting point;
no debug-mode switch or general diagnostic service is claimed. See the
[working stance](../../../docs/plans/agent-orchestrator/methodology.md#develop-the-application-with-inspectable-debug-evidence).

Share transcript presentation, Markdown interpretation, tool expansion, source
inspection and measurement formatting. Keep provider/live/history adapters separate
and retain their native inputs. A live reducer reconciles deltas and completions;
a history adapter reads persisted records. Neither should force the other to
invent missing events or measurements.

Identity needs scope: a response ID, message wrapper UUID and tool-use ID are not
interchangeable. Likewise, a native completion phase, response stop reason and
SDK query result describe different things. Version and evidence provenance must
survive projection changes. The small local view types in this spike demonstrate
that boundary; they are not a proposed universal SDK schema.

Existing 059 pure history/Markdown logic could be reused. Its full RichText
component also imports that application's image state, so the new page uses a
small local presentation wrapper instead of pulling in another app's controls.
That is a concrete candidate for later component extraction, once the reviewed
interactions are stable enough.

## Qualification, cost and limits

Eight real no-model backend checks and six interpretation regressions passed.
The actual browser ran one paid tool-producing turn per provider, read native
history, compared content and ended both runtimes. Desktop and 390-pixel layouts,
source inspection and captured-stream replay were checked. Typechecking, build
and strict documentation validation are recorded in the runbook. The live run
exposed a redundant-key recomputation diagnostic; the UI's equality gate fixed it.
An accelerated eight-millisecond-per-frame replay produced one bounded
`HOT_SCOPE_TIME` diagnostic at about 8 ms; it remains documented rather than hidden.

**Estimated experiment total: USD 0.00292343**—about 0.29 cents. Codex contributes
USD 0.00103634 using the repository's 17 October list-price snapshot; Claude reports
USD 0.00188709 through the SDK. This is not measured subscription billing or the
implementation agents' cost. See the [usage ledger](../../spikes/067-live-session-workspace/usage-ledger.md).

This remains a small working experience: no external discovery/join, automatic
reconnection, steering/queue policy, interactive callback forms, cross-host
qualification or complete image-asset handling. Codex can outlive a browser
connection; Claude's worker ends on SDK disconnect. Use **End runtime**, or stop
the owning preview, to clean up Codex. A page reload does not recover its controller;
the host's owned-run endpoints and recorded identities remain the inspection path.
Active-turn interruption was not part of these original two successful-turn checks;
065 subsequently qualified selected live cancellation cases. Saved-session
continuation and ownership controls are now available through 064/065. Larger
traces, subagents and broader failure cases remain incremental follow-ups. The
backend/client architecture review is the next handoff after these closing studies.
