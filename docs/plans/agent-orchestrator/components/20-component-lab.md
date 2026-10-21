# O20 — Reusable components, lab and AIUI integration

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Develop and review components independently, then use them in the orchestrator. Keep suitable data/action boundaries so other applications can reuse them or they can move upstream.

## Existing foundation

The linked AIUI catalog contains shipped primitives, library spikes and proposals. The [control/observation contract](../../../specs/hp-aiui-integration.md) is recorded but deliberately deferred; it is not a prerequisite for session UI.

## Proposed boundary

Use the four-layer playbook: pure transforms, controls/cells at async boundaries, components, application. Keep provider SDKs outside Solid. Improve existing AIUI pieces upstream when appropriate; new orchestration-specific components may incubate here. Do not depend on upstream internal dock/oracle/live scaffolding or copy its implementation.

**Inputs and outputs:** Explicit view data/actions and reproducible scenarios → reusable components and human-reviewable lab pages.

## Candidate progression

- **Mock:** A small gallery for candidate agent rows, transcript/tool entries, turn controls, prompt parts and diagnostics; each scenario identifies fixture versus real data.
- **First usable slice:** Promote a reviewed component into the real app, exercise it through its tool surface, and verify source linking/HMR separately from runtime persistence.
- **Later:** Extract proven reusable pieces, qualify upstream fixes against affected demos, and build the later reactive control/observation lab.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Use the [working method](../methodology.md) to review question timing before
each slice. The user subsequently requested two independent throwaway mocks in
parallel, with one web page and essence Markdown each. Review those notes and
interactions before choosing shared production boundaries. Build explicit actions first and make any later inferred intent
visible and overridable. Follow AIUI's four layers within each thin slice.

## Visual review follow-up — 19 October 2026

The [provisional visual direction](../visual-direction.md) records compact anchored
chrome, semantic detail levels, expressive CSS and Habemus Papadum design reuse.
The revised mock tests these preferences; accepted patterns may contribute back
to AIUI. Exact density, colors, motion and component boundaries remain open to review.

## Your additions

- Which components should be explored as standalone mocks first?
- Which pieces should stay application-specific, and which do you already expect to use elsewhere?

Additional requirements, examples and decisions: **TBD with you.**
