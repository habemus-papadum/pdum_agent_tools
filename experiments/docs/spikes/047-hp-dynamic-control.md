# 047: Dynamic input and independent agent control

**Question.** Can the portable HP runtime support the control patterns a Codex
power user expects without tying parent waits, child lifetime and user steering
together incorrectly?

**Result, 18 October 2026.** The selected control semantics now work in the
portable core. A parent can wait for child activity, receive a message or user
steer, change course, or be interrupted while its child keeps running. Queue-only
notes and followup tasks are distinct. Child results arrive through attributed
mailboxes, including after the parent has gone idle. Interrupting a whole subtree
requires an explicit scope.

The code now separates session input and sampling, agent control/mailboxes, and
tool execution, following the responsibilities found in the pinned Codex source.
The existing `AgentRuntime` facade and earlier tool exports remain usable. The
same implementation runs in Node and a browser Worker.

Several edge cases materially affected correctness:

- **A sent steer is not a committed input.** Startup input is queued; local
  inclusion, dispatch, provider commitment, known rejection and unknown outcomes
  remain distinguishable. Failed preparation or connection setup cannot make
  unsent input look committed or silently replay it in the next turn.
- **Wait cancellation is separate from child cancellation.** Cancelling or
  steering a waiting parent returns control without killing its child.
- **An answer closes a delivery boundary.** Later queue-only mail waits, and a
  later explicit followup starts another turn. Earlier explicit work can keep the
  current turn going. Checks cover both sides of this boundary.
- **Interrupted tools need honest context repair.** Never-started calls and
  started calls with unknown side effects get different recorded outputs. Late
  host results remain observable and never cause a duplicate action or contaminate
  a later turn.

**Validation.** Seventeen credential-free race checks pass against the actual
portable runtime, with Node-free exports for browser reuse. The original thirteen
039 tests and relevant TypeScript typechecks also pass. The parent-owned
[049 integration](049-hp-control-integration.md) records browser execution and
small real Luna control checks; fixture tests here are not provider evidence.
No paid requests were made in this track.

The final review added two boundary regressions: cancellation before a host tool
callback is accurately recorded as never executed, and an unresolved preparation
hook cannot block interruption or dispatch an old request after a newer turn.

**Scope.** This is a source-informed subset. Native task-name registration,
advanced spawn inheritance, background-process lifetime, parallel scheduling,
goals, stop hooks, encrypted agent messages and durable recovery remain gaps.
The [046 audit](046-hp-power-user-audit.md) and [detailed runbook](../../spikes/047-hp-dynamic-control/README.md)
explain that boundary and link the implementation.

**Reproduce.** From `experiments/`, run `pnpm --filter
@agent-spike/047-hp-dynamic-control test` or `probe`. Source baseline:
`6c372fbef45f730b6d8aa727b0ec8332365588db`; Node 26.10.0, TypeScript 7.0.2,
pnpm 11.9.0, macOS arm64. The suite is also imported unchanged by 049's browser
runner.
