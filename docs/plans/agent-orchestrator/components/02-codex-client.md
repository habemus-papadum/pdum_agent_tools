# O02 — Codex client SDK

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Provide complete typed access to the Codex app-server protocol, with thin helpers for histories, sessions, turns, files and commands. The orchestrator is its first substantial browser consumer.

## Existing foundation

Use the [API design](../../../specs/codex-client.md), [delivery plan](../../codex-client.md) and [feasibility findings](../../../codex-client-findings.md). No production codex-client package exists yet.

## Proposed boundary

Keep experimental APIs and raw calls accessible. History reading must not implicitly resume a thread. Snapshot/delta merging, multiple clients and pending requests must follow native identities and actual response evidence.

**Inputs and outputs:** A launched endpoint and optional host metadata → native RPC access, session handles, original observations and reusable views.

## Candidate progression

- **Mock:** The session catalogue, live thread and raw event inspector shown together, with clearly simulated connection state.
- **First usable slice:** Implement C1/C2 through a real browser workflow: read history, join/create, submit a turn, steer/interrupt, open a second client and replay a recording offline.
- **Later:** Expand through native administration, rich input, remote operations and accounting as the application needs them; qualify exported methods separately from generated availability.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Choice of useful initial native operations is delegated to implementation
judgment. Detail should progress from a lightweight sign of activity, through
a quick sanity-check summary, to deeper inspection and raw JSON where useful.
Both humans and debugging agents consume this evidence; fetching/parsing all
detail continuously is not required. Resolve the presentation through mocks and
measure the workload before fixing its data-fetch policy.

## Your additions

- Which native operations need first-class buttons in the first session view?
I'll defer to you.
- How prominent should protocol details and unsupported/experimental capability labels be?
This is important, and we'll resolve in the mop where we want multiple levels of detail. We want one level of detail which is not super intrusive and just kind of proves existence of life. You can kind of just see that things are moving along. And then another thing which kind of gives you a quick glance, basically sanity-checking what's going on, might be a view that is on by default for certain things.

There's a detailed view with multiple levels of detail that eventually might even go down to raw JSON, for all I care. The idea is that all of this detail is not going to be processed just by a human, but potentially by an agent as we're debugging the system when we're building it. PHaving fine detail is useful. We just don't want to create an unreasonable computational burden.
Additional requirements, examples and decisions: **TBD with you.**
