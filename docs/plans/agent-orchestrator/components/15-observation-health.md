# O15 — Traces, health and cost

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Explain what a session is doing and why it may be stuck, failing or expensive. Support the same useful computations in live views, historical inspection and optional host processors.

## Existing foundation

Reuse [MITM/observation boundaries](../../../specs/mitm.md), [Codex findings](../../../codex-client-findings.md) and [history analysis](../../../agent-history.md). Hosted exports and richer client reducers have separate implementation/qualification gates.

## Proposed boundary

Capture and export must not block agent traffic. Keep native events, transport evidence and derived estimates distinct, deduplicate overlapping usage, and retain missing coverage. API-equivalent price estimates are not actual subscription bills. Findings are advisory; automated intervention is a later policy decision.

**Inputs and outputs:** Provider observations, histories, optional captures and price inputs → trace views, usage/context summaries and explainable health indicators.

[O21](21-host-coordinator.md) can select these processors and aggregate status.
Place taps at the relevant session/relay boundary; a coordinator-owned relay or
required MITM proxy is still on the live failure path. After a failure, preserve
recorded coverage and mark missing tails, even when their exact size is unknown.
This evidence supports [agent-assisted recovery](../failure-recovery.md).

## Candidate progression

- **Mock:** A tool loop, sandbox errors, pending user input, context pressure, a stalled connection and incomplete cost coverage.
- **First usable slice:** Show observed tool count, pending work, usage and provenance for one real session and its saved counterpart.
- **Later:** Optional MITM/OTLP/Logfire sinks, configurable diagnostics, fleet summaries and comparison of estimates across sources.

These are discussion candidates, not scheduled work or implemented capabilities.

## Evidence-first follow-up — 24 October 2026

The [059 inventory](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-evidence-inventory.md)
tracks time axes, gap compression, settings, coverage and per-agent metrics. It separates observed native fields, prior probes, source-only
capabilities and missing examples before the next mock. No new runtime or
collection policy is implied; the original questions below remain open.

## Development capture stance — 25 October 2026

The user does not want routine historical browsing to depend on saving live-only
data. Reuse computations over the evidence each source actually provides, and
keep missing coverage explicit. Optional debug captures serve joint operator/agent
diagnosis through the MCP-connected development browser and AIUI tools; they may
be enabled by default early on and can retain unclassified records or a complete
selected observation/history. This is separate from normal native history and
existing ingestion analytics. See the [canonical working stance](../methodology.md#develop-the-application-with-inspectable-debug-evidence).
No new retention, capture or export service is implemented by this clarification.

## Your additions

- Which conditions should draw attention automatically, and which should remain available only on inspection?
- Which trace/cost details help you decide what action to take?

Additional requirements, examples and decisions: **TBD with you.**
