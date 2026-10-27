# O03 — Claude client and running-session feed

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Make Claude profiles, saved conversations and live work usable within the same
application, including several browser/Node clients attached to one owned process.

## Existing foundation

The [Claude guide](../../../claude.md), [handoff](../../../claude-handoff.md) and [qualification](../../../claude-validation.md) cover working launcher/relay examples, authentication and selected history flows.

## Proposed boundary

The existing implementation uses official SDK clients and ends a worker on client
disconnect. **The user revised that target on 25 October.** The launcher should
own a native process independently of its attached clients, with separate launch,
list, attach and stop operations. A thin service forwards client input to native
stdin unchanged, records transport traffic, and replays/fans out native output.
The journal distinguishes pipe directions; the attachment feed contains stdout,
not synthesized acknowledgements from recorded stdin.
Clients interpret outcomes and shared state; the service does not synthesize
acceptance, validate conversation commands or arbitrate semantic conflicts.

The new path does not require the official conversation SDK. Official history
helpers remain useful for independent list/read/fork operations. A running-process
journal supports full replay and may be reclaimed when the process exits; native
history remains the ordinary source for later inspection/continuation. Neither
that journal nor multiple attachments establishes coordinator-crash recovery or
attachment to arbitrary externally launched native sessions.

**Inputs and outputs:** launcher profile/history management plus the native feed
→ Claude-specific client controls and shared projections, retaining native content
and explicit replay/live boundaries. [068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
qualifies this direction before production API design; [069](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md)
compares its evidence with the other providers and data sources.

## Candidate progression

- **Focused spike:** Two clients replay and join one native process, with real
  message/control responses and process survival after both disconnect.
- **First usable slice:** Launch through a configured profile, attach/replay,
  stream turns, handle supported callbacks across clients, inspect native history
  and explicitly resume/fork. Select conflict behavior from measured evidence.
- **Later:** Qualify further authentication providers, platforms and documented remote-control entry points; retain unsupported attachment as an explicit limit.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

The user explicitly deferred both discovery-only presentation and owning-client
lifetime questions. Apply the [question-timing method](../methodology.md) and ask
when a real Claude interaction depends on them. A mock can expose the different
states without choosing an undocumented ownership policy.

## SDK reuse investigation — 26 October 2026

[071](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/071-claude-sdk-replay.md)
fills a qualification gap: 068's SDK-free probe did not test official Query
consumption of its recorded feed. The installed SDK now passed selected native
multi-client, real permission, browser reload and pending-permission reattachment
cases with a client-side replay/connection wrapper and the unchanged 068 server.
Naive full replay executed a historical hook again; a peer's accepted response
did not automatically abort the other SDK callback. Public methods plus client
projection handle the qualified cases without copying SDK internals.

The new recommendation is to retain the official SDK behind that application
layer where it fits, with raw messages still accessible. This is not yet a
production SDK decision or complete callback/SDK-hosted-tool qualification.
The SDK-free path remains available; server semantics do not depend on this choice.
Browser environment/transport adaptation and callback ownership remain explicit
implementation seams. See the report for exact public APIs and version bounds.

## Primary observer guidance — 26 October 2026

Avoid adding a primary-observer selection/election layer. Use native shared
responses and client reconciliation. If a specific hook or SDK-hosted function
demonstrably requires one designated owner, discuss that concrete case before
adding the smallest necessary mechanism. See [D4](../system/decisions.md).

## Your additions

- What should the app show for a discovered Claude session that it cannot control?
- Should the owning browser connection stay alive while all its session views are closed?

Not sure about either of these. We can kind of work these out as we go along.

Additional requirements, examples and decisions: **TBD with you.**
