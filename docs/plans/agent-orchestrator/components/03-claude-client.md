# O03 — Claude official-SDK integration

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Make Claude profiles, saved conversations and live SDK work usable within the same application. Reuse the official browser and Node SDKs and add only the surrounding integration needed by the app.

## Existing foundation

The [Claude guide](../../../claude.md), [handoff](../../../claude-handoff.md) and [qualification](../../../claude-validation.md) cover working launcher/relay examples, authentication and selected history flows.

## Proposed boundary

The client owns the SDK conversation; Python owns profiles/processes and relays bytes. Current client disconnect ends that worker. A second view may share an application-owned SDK instance, but arbitrary independent attachment to native CLI sessions and durable recovery are not established.

**Inputs and outputs:** Launcher profile/history management and the official SDK → Claude-specific live controls and shared display projections, with native content retained.

## Candidate progression

- **Mock:** Show discovery-only Claude sessions alongside a managed SDK session, including what happens when its owning client closes.
- **First usable slice:** Launch through a configured profile, stream a turn, handle supported callbacks, inspect saved history and explicitly resume/fork through official helpers.
- **Later:** Qualify further authentication providers, platforms and documented remote-control entry points; retain unsupported attachment as an explicit limit.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

The user explicitly deferred both discovery-only presentation and owning-client
lifetime questions. Apply the [question-timing method](../methodology.md) and ask
when a real Claude interaction depends on them. A mock can expose the different
states without choosing an undocumented ownership policy.

## Your additions

- What should the app show for a discovered Claude session that it cannot control?
- Should the owning browser connection stay alive while all its session views are closed?

Not sure about either of these. We can kind of work these out as we go along.

Additional requirements, examples and decisions: **TBD with you.**
