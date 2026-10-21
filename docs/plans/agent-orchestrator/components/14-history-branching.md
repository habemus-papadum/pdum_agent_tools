# O14 — History, search, organization and branching

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Find earlier sessions and traces, inspect them without a live agent, tag/mark useful work and explicitly continue or branch from supported points in history.

## Existing foundation

[Agent history](../../../agent-history.md) already has ingestion, lineage, queries and tags. [Codex history feasibility](../../../codex-client-findings.md) and official Claude helpers qualify selected read/resume/fork paths; browser browsing and arbitrary-point operations are not universally implemented.

## Proposed boundary

Read/replay is inspection. Resume/fork/clone starts or changes live conversation state only through an explicit operation. Historical context does not rewind files, recreate tools or undo side effects. Expose supported branch points and coverage rather than pretending every message can be resumed.

**Inputs and outputs:** Saved sessions, lineage, annotations and search results → historical views and deliberate provider-specific continuation requests.

The [coordinator recovery sketch](../failure-recovery.md) makes these records a
practical fallback after execution loss. A recovery agent may use native
resume/fork or construct a new prompt from available history and current
workspace evidence. Label reconstructed context, gaps and replacement lineage;
do not imply a complete transcript or filesystem rollback.

## Candidate progression

- **Mock:** Search results, tagged sessions, a lineage view and a selected historical point with separate inspect and continue actions.
- **First usable slice:** Read real saved history, mark it, and perform one qualified fork/resume flow into a chosen workspace/profile.
- **Later:** Cross-host search, richer trace queries, comparisons and clone templates. Cross-provider transfer would be explicit context import, not native resume.

These are discussion candidates, not scheduled work or implemented capabilities.

## Your additions

- What should search cover first: prompts, tool output, time, repository, tags, model or something else?
- What should cloning preserve, and how should the workspace choice be presented when continuing old work?

Additional requirements, examples and decisions: **TBD with you.**
