# 039: A portable runtime with a Codex-shaped client surface

**Question.** Can one small TypeScript runtime own agent execution in a browser
Worker and Node while reusing Codex app-server messages, preserving separately
addressable children and exposing history without inference?

**Result, 18 October 2026.** The local prototype does so for a deliberately small
surface. The same client flow over real Node MessagePorts created a parent,
executed a host tool, steered a response, spawned and messaged a child, forked the
parent, and reconstructed three histories offline. The browser UI and independent
Worker bundle compile from the same runtime. These local runs use a deterministic
provider fixture; actual browser/provider qualification is reported separately
in [040](040-hp-integration.md).

The useful architectural boundary is **a portable execution owner behind a
transport-neutral protocol interface**, with host-supplied model connections,
tools and persistence. A browser needs no actual TCP app-server for the UI to
reuse the message surface. Children are independent async executions with their
own IDs and histories; forking instead copies an idle conversation's context.

The prototype preserves native request/result/error envelopes, `thread/*` and
`turn/*` method names, and selected item/turn notification payloads. Thirty-nine
emitted notifications validated against generated experimental schemas from the
pinned Codex revision. Its metadata and event shapes are useful client reuse
evidence, **not** evidence that the vanilla remote Codex CLI can operate against
this subset. Unsupported methods and parameters return explicit errors.

The key distinction in the history design is that a transcript is not model
context. The prototype retains both. Sent steering remains visible, while only
committed input enters model context. Replacing context with a host checkpoint
leaves the transcript intact. That operation establishes the context boundary;
automatic and model-generated compaction remain unimplemented. Offline replay
creates no runtime, connection or model request.

The existing agent-history v5 writer accepted the exported rows: three threads,
five turns, fourteen items and blobs, one fork edge and one spawn edge. Inherited
items are marked copied context; no usage was fabricated for fixture calls.
The eval tool recognizes the mapped generic `toolCall` records. Its existing
Luna price table and inherited-tool-byte sum need correction before relying on
cost/byte comparisons. The full coding eval was not run.

**Validation.** Thirteen tests passed, including real MessagePort traffic, two
listeners, independently steered/interrupted concurrent children, failing tools and observers, uncommitted
steering, inference-free reads, fork isolation and offline replay. Typecheck,
browser/Worker build, Node demonstration, native notification schema validation
and actual DuckDB schema writing passed. No paid requests were made in this track.

**Reproduce.** From `experiments/`, run `pnpm --filter
@agent-spike/039-hp-agent-runtime test`, `demo`, `build`, then `serve`. Open
`http://localhost:8039` for the fixture demonstration. The
[README](../../spikes/039-hp-agent-runtime/README.md) gives exact commands, native
subset semantics, source references, schema checks and integration APIs.

**Scope.** This is research code with ephemeral state, sequential tools and a
snapshot journal. Skills, MCP, filesystem/shell tools, compaction, prompt-inspector
UI, durable storage/recovery, image input and complete native protocol coverage
are absent. Those gaps are explicit implementation work, not compatibility shims
hidden in the shared client. Reference: Codex
`6c372fbef45f730b6d8aa727b0ec8332365588db`; macOS arm64, Node 26, pnpm 11.9.0,
TypeScript 7.0.2 and esbuild 0.28.2.
