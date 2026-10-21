# O09 — Session workspace and turn controls

**Status: design stub.** [Back to the component map](../index.md).

The [session interaction study](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/054-orchestrator-session/README.md)
now explores source selection and explicit delivery intent with fixtures. Its
web page and Markdown inform later specification, not provider guarantees.

## Purpose

Interact with a live conversation while retaining its context, pending work and effective settings. Support several open sessions and navigation between parent and child work.

## Existing foundation

The [Codex C2 plan](../../codex-client.md), official Claude examples and [HP control evidence](../../../hp-agent-parity.md) provide the provider boundaries; the reusable UI remains to be designed.

## Proposed boundary

Joining, observing, leaving, interrupting and ending the owning runtime are distinct. Per-turn model, intensity/effort and service tier use provider-supported values and record effective settings. Do not imply that changing the next-turn settings modifies a running turn. Preserve supported multi-client responses and resolve races from provider evidence.

**Inputs and outputs:** Session handle, prompt draft and supported settings/actions → submitted/steered input, pending requests and live state.

## Candidate progression

- **Mock:** A session pane with next-turn settings, active streaming, a pending question, steer/interrupt choices and a disconnected observer.
- **First usable slice:** A real text turn and tool result with clear acknowledgement/completion, a second view/client where supported, and honest detach behavior.
- **Later:** Queue editing where available, richer turn controls, pending-request coordination and personalized session layouts.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Follow the [explicit-intent method](../methodology.md#make-the-users-intent-explicit-first).
The person chooses whether input steers an active turn, waits for a supported
delivery boundary, queues a new turn or requests interruption/replacement.
Expose target, timing and observed outcome. Show only provider-supported meanings
and do not silently change intent when a turn ends before dispatch. A visible
mode/action label can express the choice without an extra confirmation dialog.

Later conveniences may infer a likely mode, but must show what was selected and
allow an explicit override. The first mock should establish the explicit
interaction before adding such inference.

## Your additions

- How should send, steer, enqueue and interrupt be distinguished in the interaction?
- Where should model, effort and tier appear, and what should persist between turns?

Additional requirements, examples and decisions: **TBD with you.**
