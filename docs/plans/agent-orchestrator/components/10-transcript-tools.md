# O10 — Transcript and tool visualizations

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Make messages, reasoning that the provider exposes, tool activity and results readable at several levels of detail. Reuse the same rendering pieces in live sessions, history and trace inspection.

## Existing foundation

The existing [history tools](../../../agent-history.md) supply records and forensics. AIUI's current catalog includes JsonView, TextView, ToolLog and PromptRecordView; ToolLog's own application-tool stream is not automatically an agent transcript.

## Proposed boundary

Keep native item IDs and original data behind derived views. Separate partial output from completed replacements; mark missing/truncated data and unavailable assets. A renderer must not execute tools or create model work when inspecting history.

**Inputs and outputs:** Transcript items and status/coverage metadata → readable timeline entries, expandable tool views and links to raw evidence.

## Candidate progression

- **Mock:** Streaming text, parallel calls, a long command, a patch/diff, a rich result, an error and a missing-output gap.
- **First usable slice:** Render a real session and a recorded session with shared components; compare what the data actually supports.
- **Later:** Specialized renderers, linked source/files, reasoning/context inspection and configurable density without flattening unsupported native fields.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

The [O02 comments](02-codex-client.md#your-additions) ask for several levels of
detail, from unobtrusive activity to raw JSON, useful to humans and debugging
agents. Expanding detail should not require every session to fetch/parse all raw
evidence continuously.

The [O17 request](17-files-commands.md#your-additions) adds meaningful file links:
retain host/working-directory context, open a read-only source view, annotate or
select code and carry the selection into a prompt. Historical evidence and
current file contents must remain distinguishable.

## Evidence-first follow-up — 24 October 2026

The [059 inventory](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-evidence-inventory.md)
tracks operation-specific rendering and image/message semantics. It separates observed native fields, prior probes, source-only
capabilities and missing examples before the next mock. No new runtime or
collection policy is implied; the original questions below remain open.

## Your additions

- What should be collapsed by default, and what must remain visible during execution?
- Which tool-result types deserve specialized presentation first?

Additional requirements, examples and decisions: **TBD with you.**
