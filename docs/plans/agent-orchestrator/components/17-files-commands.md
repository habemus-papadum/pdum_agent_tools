# O17 — Files and remote commands

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Inspect files and run host commands directly from the application, with streamed output and supported interactive input, independently of model turns.

## Existing foundation

The [Codex remote-operation findings](../../../codex-client-findings.md) and [client C3 plan](../../codex-client.md) distinguish file APIs, raw process operations and model-facing shell tools. HP's Node pipe adapter has its own tested limits.

## Proposed boundary

Always show the target host and working directory. Terminal/session control must preserve ownership, stream identity, input and final-output semantics. Do not label pipes as a PTY. A browser proxies native operations through a supported host adapter; this does not imply every provider exposes them.

**Inputs and outputs:** Host paths and explicit command requests → file content/watch events or process handles/output/exit evidence.

## Candidate progression

- **Mock:** A session log link opens a contextual read-only source viewer; comments and selected code feed a prompt draft. Explore terminal presentation separately when that workflow is selected.
- **First usable slice:** Resolve and read a real referenced file through one qualified host, retaining host/path/content provenance through selection into a prompt. Command streaming follows as a separate slice with its own lifetime checks.
- **Later:** Supported PTYs, resize, binary transfers, watches and links from transcript items into host inspection.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Prioritize meaningful links in a session log. Resolve relative references using
the associated host and working directory, including line information where
available. Show the resolved target and whether the viewer is reading current
bytes or retained historical content.

Open code read-only, support comments/selection and let the user add selected
material to a prompt. Editing the source file is not required. Annotation
persistence, anchoring across file changes and ambiguous references are questions
to answer before those real behaviours are implemented. The first mock can use
temporary local comments and explicit fixture provenance.

## Your additions

- Should this be a session side panel, a host-level workspace, or both?
- Which terminal/file capabilities are essential before it becomes useful day to day?
One thing that would be useful, pretty importantly, would be to be able to click on a link in a session log that understands what it is. Quite often, those links are to files that have a notion that is relative to a working directory.

Be able to view the file in the orchestrator with the source code and commenting, not necessarily edit the file, but just be able to view it. Also use that for selecting code and submitting a prompt.


Additional requirements, examples and decisions: **TBD with you.**
