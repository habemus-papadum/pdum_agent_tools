# 049 — Dynamic-control integration in Node and Chrome

**Observed 18 October 2026:** the source-aligned HP core passed real provider
checks for mailbox-woken waits, steering-woken waits, and interruption followed
by a new turn on the same thread. Six Luna responses produced `MAIL_OK`,
`STEER_OK` and `RECOVERED` in their respective cases. The note sender was
host-controlled; these checks qualify delivery/continuation, not autonomous
message selection.

The existing browser inventory task was rebuilt with the refactored core and
rerun against live Luna. Its parent model spawned a child, waited for the child's
actual tool result and annotated the dashboard with **41**. Both loops ran in the
Worker. Two threads, four tools and six provider responses completed, and all
six outgoing prompt records verified with the actual AIUI toolkit.

The same portable control scenarios also ran in Node and actual Chrome with
scripted model events. They cover retained messages before waits, note/followup
separation, timeout, thread/subtree cancellation, startup steering, answer
boundaries, failed preparation, interrupted tool pairs and late host outcomes.
Local MessagePort tests add multiple-client observation, detachment, malformed
envelopes, send failure and synchronous/asynchronous observer failure. Scripted
checks are identified separately from live provider evidence.

The inspected Rust responsibilities are now reflected in HP's module boundaries:
session input and sampling, agent control/mailboxes, and tool execution, with
transport and host adapters outside the portable core. An explicit input record
distinguishes queueing, local inclusion, send, commitment, rejection and unknown
outcome. An interrupted tool call is closed with an honest not-executed or
outcome-unknown result; a later host result cannot silently contaminate a new turn.

**Cost:** Node USD 0.000704200 and browser USD 0.000841860, totaling
**USD 0.001546060 estimated reported usage**. Actual billing and research-agent
costs are unknown. No other investigation in this round made paid calls.

This improves selected control behavior, not complete native parity. Background
job lifetime, tool concurrency, user queues, human requests, dynamic tool changes,
durability and goals remain explicit items in the [feature inventory](046-hp-power-user-audit.md).
The [runbook](../../spikes/049-hp-control-integration/README.md) has reproduction,
precise evidence paths and limits. Start with the [overall report](../../../docs/hp-agent-parity.md)
for the recommendations.
