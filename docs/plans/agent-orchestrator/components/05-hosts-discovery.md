# O05 — Hosts, discovery and tracked sources

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Define the machines, profiles, launchers and browser runtimes the orchestrator tracks. Build a current inventory with enough provenance to distinguish known, running, stale and unreachable entries.

## Existing foundation

Existing [launchers](../../../implementation-status.md), profile inspection and [history sync](../../../agent-history.md) provide pieces. A unified multi-host inventory/management client is proposed.

## Proposed boundary

Discovery and control are different capabilities. Preserve provider/native IDs plus host/profile/source identity; the same session can appear in history and live inventory without becoming two agents. Unknown reachability is not stopped execution. The [O21 host coordinator](21-host-coordinator.md) supplies unified management, foreground first and optionally daemon-hosted later; partner hosts retain local process ownership.

After failure, reconcile available records and verified live identities. Report
unrecoverable or uncertain runs honestly; [history-based relaunch](../failure-recovery.md)
is acceptable and does not require seamless process adoption.

**Inputs and outputs:** Operator-configured endpoints and source selections → host/profile/runtime/session inventory, freshness and available actions.

## Candidate progression

- **Mock:** Several hosts and profiles, including duplicate observations, an unavailable host and a browser-local runtime.
- **First usable slice:** Configure one local management endpoint and show its actual profiles/owned runs plus supported read-only discoveries.
- **Later:** Add remote hosts, source groups, configurable tracking rules and explicit connect/adopt paths where supported.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Distinguish the coordinator's host inventory from browser-local test agents.
The UI may display both, but browser-local entries come from its own application
state, not remote administration or discovery of other tabs. Tracking scopes
and refresh policy remain open questions; ask when a live discovery slice needs
them. Data placement follows the investigation proposed in O01.

## Your additions

- Which scopes should be configured: individual profiles, directories, machines or saved groups?
- Should discovery refresh continuously, on demand, or both—and how should stale results remain visible?

Additional requirements, examples and decisions: **TBD with you.**
