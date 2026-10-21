# O22 — Development instances and application delivery

**Status: design entry, 19 October 2026.**
[Back to the component map](../index.md).

## Purpose

Make development cheap to restart and safe to run concurrently: each agent or
human can launch an isolated application/coordinator instance, inspect it through
a known browser tool connection, and stop its own resources. Decide product
packaging from actual needs without delaying throwaway interaction mocks.

## Existing foundation

AIUI's application-pattern guide distinguishes browser applications with custom
services, portable Electron packaging, and desktop-specific applications. Its
DevStack and Electron Stack experiments demonstrate lifecycle/readiness and
concurrent development patterns; `aibr` provides deliberate browser selection.
These are reference implementations in `.dev/aiui`, not already-integrated
orchestrator features. See the [development-flow sketch](../development-flow.md).

## Proposed boundary

Keep a browser-compatible frontend and explicit service/host adapters. The first
development candidate is browser plus an isolated foreground backend, because
the same UI can be inspected in the session's Chrome DevTools browser and tested
with headless Chromium. Add an Electron host when a concrete desktop interaction
needs it. Both modes may coexist temporarily; do not build two independent UIs
or commit to maintaining both distributions forever.

Production robustness and shared services do not require development instances
to share state. Ports, runtime directories, profiles, local databases, logs,
browser state and generated outputs need deliberate per-instance ownership.
Separate source checkouts/worktrees when edits conflict; disjoint mock folders
are sufficient for the current work. An app-specific browser profile alone does
not isolate concurrent agents using that same profile.

## Candidate progression

- **Now:** Two disposable web mocks, each with an essence Markdown for future
  specification. An HTTP/Vite preview host has allocated ports, private caches and
  an instance record. Actual Solid/AIUI graphs, source tooling and selected hot-edit
  persistence are qualified; coordinator/native sessions and provider connections
  remain separate live-development work.
- **Before the first live app:** Qualify one command that starts frontend and
  an isolated coordinator, reports actual endpoints and stops only owned work.
- **Later:** Compare browser-only and Electron development over the same
  frontend; qualify desktop-specific operations and packaging separately.

## Your additions / questions at the right time

- Which desktop-only capability, if any, makes Electron necessary?
- Should a packaged app own its coordinator, connect to an existing host daemon,
  or offer both explicitly?
- Which development state should reset by default, and which diagnostic/history
  artifacts should remain available after a failed run?
- When is sharing an authenticated browser/profile deliberate versus accidental?
- What evidence would let us retire one delivery mode without weakening testing?

These choices do not block fixture-only mocks. Ask before implementing the
dependent live lifetime, persistence or desktop behavior.
