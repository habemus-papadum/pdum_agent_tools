# 064 — Native history into a live continuation

**25 October 2026 — working experience and selected live flows qualified.**
Open [the live workspace](http://localhost:56044/session-lab/) and choose
**Saved sessions**. The panel reads the lab profiles' actual native histories,
independently of the current conversation and draft. Choose **Resume latest** or
**Fork from a point**, open the continuation, then explicitly send the draft.
The [runbook](../../spikes/064-history-continuation/README.md) maps the operations.

Both providers passed real continuation checks using the earlier 067 sample-file
conversations. Resume kept the original conversation ID and recalled its marker.
A new continuation-only code was added to that source. Fork then used the earlier
boundary, created a different conversation ID, excluded the later code, and left
the source's native message content unchanged. The forked agent recalled the
original marker and three apples without reading the file again. Opening either
operation preserved the draft and submitted no prompt from the client.

| Operation | Codex | Claude |
| --- | --- | --- |
| Read/list | Public app-server history RPC; temporary read-only owner where needed | Official Python SDK helpers scoped to the profile and known working directories |
| Resume latest | Browser `thread/resume`; same native thread ID | New official SDK worker launched with the existing session ID |
| Fork boundary | Inclusive native turn ID via `lastTurnId` | Inclusive assistant-message UUID via official `History.fork(up_to_message_id)` |
| New live view | Saved baseline followed by this connection's new observations | Same presentation, with provider-specific identity and usage interpretation |

The first study fixes continuation to the source profile and recorded working
directory. It does not invent cross-provider context transfer, filesystem restore
or generic arbitrary-message rewind. The UI offers the native boundaries supplied
by its reader; only the selected completed source boundaries were live-qualified.
Codex failed/interrupted-turn boundaries and other Claude cut locations need their
own evidence before broader claims.

## What this tells us about the interface

A history reference needs provider, profile, native conversation identity and
working-directory scope. A continuation request needs an explicit operation and
a provider-labelled boundary. A runtime/run identity is separate from the retained
or newly created conversation ID. The handoff can carry that description while
the provider client keeps its native control API.

Saved baseline content and incoming live content can share transcript components.
Their measurements and raw identity scopes remain distinct. The new projection
qualifies continuation of ended histories; it is not a general algorithm for
joining overlapping streams from arbitrary running sessions. Native reads work
without debug stream captures. Captures here support development/reproduction,
following the user's working stance rather than defining another history store.

Resume can have provider side effects such as reactivating a saved goal (RC-05).
The client now preserves an observed active state instead of blindly marking every
resume idle; our selected source conversations had no such goal. No automatic
prompt retry, goal policy or recovery guarantee was introduced.

## Evidence and cost

Eight new real no-inference backend checks passed for native catalogue/read/fork,
source preservation, invalid point rejection and ownership boundaries; the eight
existing backend checks still pass. Four explicit paid browser turns qualified
resume and fork for both providers. Ten read-only UI checks cover draft/state
preservation, point selection and provider/source mismatch, with desktop/phone
review. Native source signatures and run identities are in ignored
`064-history-continuation/browser-evidence.json`; raw observations remain in the
067 run directory.

The four continuation inputs cost an estimated **USD 0.00456925**. Combined with
065's two active-interruption inputs, the round totals **USD 0.00670693** under
the saved 17 October pricing snapshot. This is API-equivalent estimation, not
subscription billing. Inherited conversation totals were excluded; see the
[shared usage ledger](../../spikes/064-history-continuation/usage-ledger.md).

Versions: Codex 0.164.0, Claude Code 2.1.310, browser SDK 0.3.296, Python history
SDK 0.2.165, macOS. No production client library was extracted. Cross-view links
from the broader statistical corpus, cross-host continuation, active-source forks,
images and general recovery remain later implementation work. This study supplies
the needed continuation boundary for the backend/client architecture review.
