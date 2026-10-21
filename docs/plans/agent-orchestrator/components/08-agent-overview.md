# O08 — Agent overview and attention

**Status: design stub.** [Back to the component map](../index.md).

A [throwaway interaction study](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/053-orchestrator-overview/README.md)
now supplies a runnable fixture page and essence note. User review and a concrete
spec remain next; this is not a live orchestrator feature.

## Purpose

Provide the everyday view of all tracked agents: what is active, what changed, what needs input and what deserves investigation. Open several sessions without losing this overview.

## Existing foundation

Inventory comes from [O05](05-hosts-discovery.md); reusable health evidence comes from [O15](15-observation-health.md). Existing native agent browsers inspire the experience but do not establish a cross-provider implementation.

## Proposed boundary

Keep native activity, pending human input, discovery freshness and advisory health separate. Missing updates are not proof of failure. Filtering a view must not stop the hidden agents.

**Inputs and outputs:** Inventory, session summaries and observation freshness → grouped/sorted agent rows or cards and navigation actions.

## Candidate progression

- **Mock:** A mixed-provider fleet with running, idle, waiting, completed and unreachable sessions, children and several profiles.
- **First usable slice:** Connect the selected mock presentation to real inventory and session opening; launch another agent from the overview.
- **Later:** Saved views, pins, tags, attention queues, comparisons and larger fleets, driven by observed usage rather than a speculative dashboard.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

The user's [O01 comments](01-client-foundation.md#your-additions) request
native-agent-browser information plus context percentage, estimated price and
status. Explore information-rich cards/icons as well as density alternatives;
a row layout is not a requirement. Separate a cheap sign of activity, a quick
summary and deeper forensic detail, retaining unknown/stale evidence explicitly.

Begin around 30–40 entries: a handful of long-lived agents, ad hoc consultants
and temporary workers. Thousands of workers should ordinarily be manageable in
aggregate, with individual drill-down for debugging. These are usage patterns,
not a mandatory type taxonomy or a claim of measured scalability.

## Visual review follow-up — 19 October 2026

The [provisional visual direction](../visual-direction.md) records compact anchored
chrome, semantic detail levels, expressive CSS and Habemus Papadum design reuse.
The revised mock tests these preferences; accepted patterns may contribute back
to AIUI. Exact density, colors, motion and component boundaries remain open to review.

## Runtime lifetime finding — 19 October 2026

Codex’s native Ready/Inactive distinction describes whether that app-server has a
loaded runtime, independently of completion, archival and observation freshness.
An overview can inspect inactive history without resuming it. Keep those meanings
separate when extending the mock or defining inventory fields.

See [Spike 056](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/056-codex-inactive-lifecycle.md)
for the versioned source investigation and probe boundaries.

## Your additions

- Which facts make an agent row useful at a glance?
- What grouping and density feel natural: host, profile, project, task family, attention state or something else?

Additional requirements, examples and decisions: **TBD with you.**
