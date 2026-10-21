# O16 — Ingestion and corpus analytics

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Turn histories from configured hosts/profiles into a corpus that supports useful queries, comparisons and statistics. Query local DuckDB or MotherDuck using the existing shared contract.

## Existing foundation

[Agent history](../../../agent-history.md) implements Python readers/sync and TypeScript query/forensics, with local and MotherDuck targets. The [roadmap](../../agent-analysis-roadmap.md) records provenance, coverage and storage policy.

## Proposed boundary

Keep native-storage readers in Python and query/analysis code in TypeScript. Reuse schema/version ownership and six-month coverage policy; do not add a separate browser history schema. Ingestion does not take control of a live conversation. Preserve source host/root identity and report incomplete syncs.

**Inputs and outputs:** Configured history sources and sync results → queryable facts/blobs, saved queries and links back to sessions/traces.

[O21](21-host-coordinator.md) may host local ingestion/query services and own local
DuckDB writes, or use MotherDuck for analytical storage. Keep sufficient local
run identity/history references for practical reconciliation when cloud queries
are unavailable. Expensive queries stay off the management event loop, and stale
analytics does not establish that a process stopped. Placement and coordination
remain open; preserve the existing Python-reader/TypeScript-analysis split.

## Candidate progression

- **Mock:** Source coverage/sync status and a few chosen questions with drill-down from aggregate numbers to evidence.
- **First usable slice:** Read an existing ingested database in a browser-facing view and drive a selected query; expose current sync status before adding scheduling.
- **Later:** Multi-host coordination, MotherDuck dashboards, saved analytical views and shared live/historical health computations.

These are discussion candidates, not scheduled work or implemented capabilities.

## Your additions

- What are the first three corpus questions you want answered routinely?
- How should sync be triggered and its freshness/coverage shown?

Additional requirements, examples and decisions: **TBD with you.**
