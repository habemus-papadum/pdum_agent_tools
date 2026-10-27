# O21 — Unified host coordinator and management client

**Status: accepted direction, design stub; 19 October 2026.**
[Back to the component map](../index.md).

## Purpose

Provide one management entry point per host for discovery, profiles,
authentication, launching, status and selected observation/ingestion services.
Run it in a terminal first; support running the same coordinator as the host's
optional daemon later. Provider launchers remain reusable libraries.

## Existing foundation

The Python launchers already expose async library APIs, process identity/run
records, relays and observation hooks. History ingestion supports local DuckDB
and MotherDuck. A unified coordinator, TypeScript management client, partner-host
routing and coordinator recovery are proposed, not implemented.

## Proposed boundary

Initially compose the existing libraries from Python rather than parsing their
CLI output. A browser/Node TypeScript management client talks to this coordinator;
provider-specific SDKs handle live conversations. Return a connection description
with run/provider/host identity, endpoint and capability/lifetime information,
not just an unqualified URL. Launching a runtime need not create a conversation.

Prefer a direct client-to-session endpoint where practical, with explicit relay
paths when needed. A distinct URL is not independent survival if the coordinator
still owns its relay, process pipes or required MITM proxy. Independent session
workers/supervision are possible later, not prerequisites for a useful first
version. The [recovery sketch](../failure-recovery.md) explicitly permits lost
execution and an agent-assisted relaunch from available history.

The coordinator selects launcher processors and can expose aggregate status,
ingestion and local query services. Observation remains asynchronous. Preserve
shared TypeScript analysis rather than duplicating it inside Python. Keep enough
local operational records for inspection/reconciliation even when cloud
analytics is unavailable. Database placement, worker hosting and peer routing
remain adjustable.

## Candidate progression

- **Mock:** One host-management view with launch progress, separate session
  connectivity and a coordinator failure followed by incomplete recovery.
- **First usable slice:** Foreground library composition, a management client,
  connection handoff and honest status/history after failure. Existing
  owner-bound cleanup and history-based relaunch are acceptable starting behavior.
- **Later:** Optional daemon hosting, partner coordinators, independent endpoint
  lifetimes and verified rediscovery/reconnection where they earn their cost.

## Recorded review — 19 October 2026

The user delegates technical recommendations about ownership, failure and
recovery to investigation of the actual subcomponents, and wants to discuss
those recommendations before the choices are fixed. Provider launcher changes
are allowed when they improve host composition; existing shapes are not
immutable.

O01 additionally asks us to measure which summary/detail facts belong in
coordinator projections, direct-client queries or forensic storage. Support
30–40 actively managed agents first and investigate larger aggregate workloads
without forcing thousands of live detail subscriptions. Browser-local HP agents
are outside this coordinator's administration; optional log ingestion is a
separate concern.

## Closing ownership evidence — 25 October 2026

[065](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md)
measured graceful cleanup and abrupt loss of the actual lab owner. Codex native
processes could survive while their public relay disappeared; Claude's worker
exited. A distinct endpoint URL alone does not establish independent hosting or
recoverable handles. Current-owner observations and prior-owner records are now
separate in the working UI. The architecture review can start from foreground
ownership, graceful cleanup and explicit history-based continuation, with crash
reconciliation and independent endpoint hosting left as deliberate later work.
The user still reviews policy recommendations before they become guarantees.

## Revised Claude ownership input — 25 October 2026

The user's next Claude direction separates launcher-owned process lifetime from
client attachment. [068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
tests transparent stdin forwarding, native-output fanout and replay for multiple
clients. Process/profile management and transport remain host responsibilities;
conversation interpretation and conflicting action handling remain client
responsibilities. This revises the target client-disconnect policy, not the
already measured production behavior or the unresolved owner-crash policy.
Use [069's provider matrices](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md)
when choosing which ownership and history facts the management API can expose.

## Your additions

- Which work should survive a normal coordinator exit, versus a crash?
- Which recovery operations should be automatic under a selected policy, and
  which should be offered as explicit operator/agent actions?
- Which services belong in the coordinator process versus independent workers?
- What loss is acceptable for particular workflows, and what evidence is most
  useful to a recovery agent?


The way we solve this is that I would defer to your suggestions based on the internal details of the subcomponents, but I'd want to talk through them because I think this is complicated. We might want to make changes to the launcher processes to be more accommodating to this host-based methodology. I'm just not sure.

Precise policies, APIs and guarantees: **TBD through preferences and spikes.**
