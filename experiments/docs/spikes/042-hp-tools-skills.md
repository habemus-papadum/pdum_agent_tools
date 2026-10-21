# 042 — HP host tools, explicit skills and real MCP

**Question.** Can the TypeScript runtime perform real coding work using native
tool names and patch grammar, explicit skill acquisition and an official MCP
client without delegating its host tools back to native Codex?

**Observed 2026-10-18:** the [runnable spike](../../spikes/042-hp-tools-skills/README.md)
exports usable 039 `Tool[]` adapters for `exec_command`, `write_stdin` and
freeform `apply_patch`. **20 tests pass**, including a real failing Node test
fixed through the patch tool and rerun successfully; incremental process
input/output; cancellation during stdin backpressure; TERM-ignoring descendant
cleanup after leader closure; patch failures and partial move side effects;
skill source reload/ambiguity; and real local HTTP MCP initialization, tool
calls, error propagation and cancellation. Strict typecheck, the local probe
and a browser-target remote/MCP bundle also pass. No provider requests were made.

**Actual native comparison:** HP and the existing source-pin binary
`artifacts/003-codex-control/target/debug/codex` (`codex-cli 0.0.0`, source
`6c372fbef45f730b6d8aa727b0ec8332365588db`) match success/failure **and resulting
file bytes on 11/11 patch cases**: nested add/overwrite, update/move, delete,
whitespace/named anchors, EOF matching, missing-newline append, ordered chunks,
missing context/delete, malformed headers and partial earlier edits. Native
app-server `command/exec` also matches buffered exit/stdout/stderr content and
interactive stdin output. This is a selected local comparison, not direct
qualification of the model's unified-exec handler or complete native parity.
Source baselines are
[`shell_spec.rs`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/shell_spec.rs),
the exact native
[`apply_patch.lark`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/assets/tools/apply_patch.lark)
and the native apply-patch parser/replacement modules. HP implementations have
**no native binary dependency**; the binary is only a comparison oracle.

**Integration.** `createNodeTools({cwd})` returns normal runtime tools plus
`close()` and `sessions()`. Shell results are JSON strings with `output` and
`exit_code` or `session_id`; nonzero exit remains a normal command result.
Patch results include human output and structured `{kind,path,move_path?,before,
after}` changes. The operator host owns process lifetime; cleanup targets only
groups spawned by this adapter. No blanket runtime time/output quota is imposed.
`createSkillContext({roots})` discovers only explicit roots and `load(nameOrPath)`
returns exact `SKILL.md` text with path, SHA-256, modified time and optional
revision. `createSkillTools` exposes explicit model loading. The official MCP
SDK adapter preserves original input schemas and complete result JSON, including
resources, structured content and errors. `remote.ts` supplies browser-compatible
HTTP MCP and application-owned execution RPC adapters without Node disk/process
imports.

**Reproduce / evidence.** From `experiments/`, run the
`@agent-spike/042-hp-tools-skills` scripts `test`, `typecheck`, `probe`, `build`,
and optionally `native` after [vendor setup](../../vendor/README.md).
`HP_CODEX_BINARY` can name the comparison executable. Native probes isolate
`HOME`, `CODEX_HOME` and files and submit no turn to a model. Ignored
`artifacts/042-hp-tools-skills/{local-summary,native-summary}.json` records the
actual calls/comparisons; `remote.js` is the browser bundle. Node 26.10.0, pnpm
11.9.0, TypeScript 7.0.2, tsx 4.23.15, esbuild 0.28.2, official MCP SDK 1.32.1.
Spend: zero provider requests, USD 0 estimated; separate coding evaluation
results belong to their own report.

**Limits.** Pipes are implemented; `tty:true` explicitly reports unsupported.
`max_output_tokens` is advisory and full output is returned. Token accounting,
PTY controls, stdin EOF controls, every native parser leniency, mixed newline
preservation, executor URI/environment routing, native skill discovery/budgets
and browser-local disk execution are not claimed. MCP resources/prompts/OAuth,
reconnects and multimodal model delivery are unqualified: retaining content JSON
inside 039's string tool result does not deliver it as a model image. Native and
HP error text and process/session transport envelopes differ.
