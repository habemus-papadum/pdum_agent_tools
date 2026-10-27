# O01 — Connections and shared client mechanics

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Give browser and Node consumers dependable connection, request and observation behavior. Reuse mechanics where they fit while keeping each provider's public protocol accessible.

## Existing foundation

The [Codex client design](../../../specs/codex-client.md) is reviewed; [HP work](../../../hp-agent-work.md) demonstrates MessagePorts, multiple observers and independent waits. Production SDK extraction remains pending.

## Proposed boundary

Transport acknowledgement, accepted work and completed work are separate. Preserve native messages, identity and unknown fields; distinguish not-sent from unknown outcomes. No automatic action replay on reconnect. Claude continues through its official SDK rather than a newly invented transport.

**Inputs and outputs:** Connections and provider events → typed operations, subscriptions, request outcomes and framework-free state projections. UI state is an adapter over this layer.

The [O21 management client](21-host-coordinator.md) handles unified discovery and
launching, then hands off a connection description to the provider SDK. A client
reconnect, a runtime rejoin and a new history-based launch remain different
outcomes under the [recovery sketch](../failure-recovery.md).

## Candidate progression

- **Mock:** A connection inspector with connected, stale, disconnected, pending and failed requests, including two observers.
- **First usable slice:** A real native connection plus Node usage: initialize, read, send one action, detach, reconnect explicitly and show any gap.
- **Later:** Per-provider capability/version reports, replay of recorded observations, request arbitration and reusable diagnostics.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

The overview needs native-agent-browser information plus context usage, estimated
cost and status. Card/row presentation belongs to O08; it does not determine
where the data is computed. Common versus provider-specific information is
independent of whether it comes from a coordinator tap, a direct client request
or historical storage.

Recommend that partition using latency, compute/transfer cost and coverage
evidence for 30–40 agents and eventually thousands of mostly aggregated workers.
Keep both cheap everyday summaries and agent-readable forensic detail. The
[first-slice investigations](../first-slices.md#focused-investigations-before-committing-live-boundaries)
make this a measured recommendation, not a guessed universal API.

## Evidence for future types — 24 October 2026

Before extracting production history/family types, consult the evolving
[native availability ledger](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-data-availability.md).
It records source/version scope, missing versus uncollected values, actor identity,
clock/duration meanings and repeated usage. The mock's temporary projections are
evidence for API design, not an already settled cross-provider schema.

## Development evidence and convergence — 25 October 2026

The [working stance](../methodology.md#develop-the-application-with-inspectable-debug-evidence)
keeps ordinary native history separate from optional development captures.
Preserving unknown native messages and exposing inspectable adapter state does
not require a second historical event store. The [closing studies and handoff](../next-mock-rounds.md#closing-studies-and-architecture-handoff)
prioritize agreement on backend ownership and browser/Node interfaces after two
narrow integration studies. Continue refining individual message interpretations
through AIUI and DevTools while building the real system.

## Revised Claude attachment input — 25 October 2026

The user now wants multiple clients per running Claude process, separate
launch/attach and full native-output replay. [068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
tests a thin process/feed service without an official conversation SDK dependency.
Clients interpret native acknowledgements and shared state; the service does not
validate conversation commands or synthesize acceptance. [069](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md)
assembles provider/source capabilities for the client design. Keep the existing
SDK launcher contract distinct from this next direction, and keep replayed
protocol evidence separate from native historical records and ingestion.

## Your additions

- Which connection information should always be visible, and which belongs in an inspector?
In general, we're looking for the information that's in something like Codex agents. That's the information that should be available, independent of whether it's a Codex, Claude Code, or HP. But then I like to see things like how much context is being used, as a percentage, price, status, and so forth. I don't necessarily know that we need a row-type display. We could even have cards that have icons and information-rich viewpoints that then let us easily select out things. Again, filter out the ones we're interested in. Again, I'm not sure if we're talking about. Some of the stuff I'm adding in may or may not belong in this specific document because there are 20 of them. It may end up being the case that I put in the wrong information in the wrong document, but I'm just going to go through one pass.

- Which conveniences should be common across providers while leaving native access close at hand?
Yeah, again, I'm not positive about this answer, and I'm not sure. I think the high-level question is what information is being computed where, rather than the UI, which I think could be resolved in a different layer.

I think there are certain types of information that we want available through the host coordinator, described in document 21, through its tap of the message stream. That could be pretty rich and always easily accessible. It might be other side information that requires using the direct client to answer. This doesn't mean you're using client-native things that are only specific to that type of client, whether it's Claude Code or Codex, whatever.

The type of client refers to Codex, Claude, or HP. There might be certain things that you go to the client directly for, and that could be universal across all three. There might be some things that are specific.

I think what I'm asking you to do is try to think through maybe a set of spikes, and then ultimately you decide the partitioning of what things are available from what source. It's based on latency and compute intensity, where we're trying to easily manage 30 or 40 things, and then eventually thousands of things.

I think of things as a handful of pets, maybe a dozen or so ad hoc consultants that will run and build something, then go away. Maybe eventually thousands of cattle, which we don't typically want to interact with in a one-to-one basis, but it might be the case that we might need that for debugging. A lot of this is around being reasonable about compute intensity under normal operations, but also having a forensic backend (particularly when you're developing the system).

Additional requirements, examples and decisions: **TBD with you.**
