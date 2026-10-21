# O11 — Subagents and background jobs

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Navigate related agents and long-running work, see their messages/results, and make the effect of wait, interrupt, cancel and terminate understandable.

## Existing foundation

[HP work integration](../../../hp-agent-work.md) qualifies shared-core children and jobs; the [parity inventory](../../../hp-agent-parity.md) records native differences and remaining gates.

## Proposed boundary

An agent tree, a fork lineage and job ownership are different relationships. Interrupting a parent need not stop its children or jobs. Cancelling an observer's wait need not cancel the producer. Cross-provider delegation is a later orchestrator operation, not an existing native subagent promise.

**Inputs and outputs:** Related session identities, mailbox events and job snapshots/history → tree/list views, progress, inspection and explicitly scoped actions.

## Candidate progression

- **Mock:** A parent waiting on two children, a completed child with queued mail, a continuing background job and a cancelled waiter.
- **First usable slice:** Open a child, inspect job output, wait/cancel independently and return to the parent through one qualified backend.
- **Later:** Large families, aggregated progress, cross-provider task relationships and reusable ownership visualizations.

These are discussion candidates, not scheduled work or implemented capabilities.

## Runtime lifetime finding — 19 October 2026

Codex’s ordinary idle-unload test does not count retained managed terminals;
shutdown terminates them. Active turns and pending interactive requests prevent
normal timed unloading, while V2 children have additional retention/eviction rules.
Before a live background-work slice, discuss whether our coordinator should retain
a subscription, warn about impending unload, or offer a separate durable job owner.
No policy is chosen by this research pass.

See [Spike 056](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/056-codex-inactive-lifecycle.md)
for the versioned source investigation and probe boundaries.

## Your additions

- Should children be inline, in a tree, in separate tabs, or selectable among these?
- How should the UI show the scope of stop actions and work that continues independently?

Additional requirements, examples and decisions: **TBD with you.**
