# O18 — Execution environments and recovery

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Later connect agent launches to controlled workspaces/containers and improve recovery after runtime or host loss. Basic failure handling and history-based relaunch belong to [O21](21-host-coordinator.md) and the [recovery sketch](../failure-recovery.md); they need not wait for this environment integration.

## Existing foundation

[Hostfork](../../../hostfork.md) already provides host-derived Linux environments and recorded-identity reopening, with explicit [qualification limits](../../../hostfork-validation.md). It does not restore previous asyncio pipes.

## Proposed boundary

Conversation state, filesystem state, credentials, processes and client attachments need separate recovery decisions. Do not blindly replay uncertain tool actions; a recovery agent can inspect current state and deliberately decide what to repeat. Existing host ownership and cleanup boundaries remain authoritative.

Seamless recovery is desirable where pragmatic, not an initial requirement.
Loss of execution or some information is acceptable if recorded honestly; an
authorized recovery agent can inspect the surviving history/workspace and start
new work. This component strengthens that fallback with explicit environment
capabilities rather than introducing a universal restoration guarantee.

**Inputs and outputs:** Launch configuration, environment identity and retained evidence → an environment-backed launch or a reviewable recovery plan.

## Candidate progression

- **Mock:** An environment selector and a failure/recovery summary showing exactly which state exists and which actions are possible.
- **First usable slice:** Deferred until the basic orchestrator is useful; select one actual environment-backed launch and validate its teardown/reopen path.
- **Later:** Cloud fleet launches, synchronization, reproducible workspace snapshots and explicitly chosen durable job owners.

These are discussion candidates, not scheduled work or implemented capabilities.

## Your additions

- Which failures should recovery handle first: browser closure, process death, host loss or workspace recreation?
- What state must be preserved, and what are you comfortable recreating?

Additional requirements, examples and decisions: **TBD with you.**
