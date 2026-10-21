# O19 — Application shell, navigation and preferences

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Compose the views into one daily workspace: overview, sessions, history, host/profile management and analytics. Make multiple simultaneous conversations easy to navigate.

## Existing foundation

AIUI supplies page/lifecycle primitives and a source-first development methodology. The orchestrator has no shell or navigation implementation yet.

## Proposed boundary

Views are disposable readers of application-owned connections, drafts and capture resources. Route changes, component remounts, page reloads and host shutdown are different events. Persisted layout/preferences do not imply durable live execution.

**Inputs and outputs:** Selected sources/sessions, routes and operator preferences → composed views, navigation state and discoverable actions.

## Candidate progression

- **Mock:** Compare a small number of layouts for overview plus multiple sessions, with direct links to an agent, turn, tool and historical point.
- **First usable slice:** Integrate the selected live slice with predictable back/navigation behavior and preserved in-app drafts/connections where ownership permits.
- **Later:** Saved workspaces, keyboard workflows, notification preferences and additional device layouts guided by actual use.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Browser-local HP test agents belong to the current application/browser session
and are not remote-coordinator resources. Do not implicitly share them across
tabs. Navigation, page destruction, local history and potential future
same-browser coordination have different meanings; ask the deferred lifetime
questions before introducing persistence or tab coordination.

## Your additions

- What layout best fits your workflow: tabs, split panes, a task list with detail, or another arrangement?
- What should survive navigation, a refresh and a new visit?

Additional requirements, examples and decisions: **TBD with you.**
