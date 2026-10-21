# 041 — HP Codex prompt and tool fidelity

**Question.** Can a portable TypeScript core reuse exact Codex prompt/tool text
and retain inspectable prompt provenance without copying a giant prompt or
silently converting native grammar tools into JSON functions?

**Observed 2026-10-18:** yes for the bounded import/record/lower/replay boundary.
The [runnable spike](../../spikes/041-hp-codex-fidelity/README.md) uses the real
`aiui-prompts` API, imports the pinned Luna template unchanged (18,037 UTF-16
units; SHA-256 `b707476816bfe5e571a1bd2179f130fff2b132da5ab8e61063acdb7fd24daf12`)
and preserves the native `apply_patch` custom/Lark schema. Six tests pass,
including whitespace/Unicode, semantic round-trip, schema/provider-item
preservation, role/order framing, mismatch detection and exact adapter-version
requirements. A browser-target bundle includes the actual toolkit and executes
its replay successfully in Node. No live browser or provider request was used.

**Source finding.** The pinned GPT-6 models select `code_mode_only`, multi-agent
v2 and `use_responses_lite:true`. Native
[request construction](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/client.rs#L951)
puts tools into developer `additional_tools` input, then adds the developer base
prompt. The native
[WebSocket request](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/codex-api/src/common.rs#L331)
has no top-level `instructions` field. The spike therefore labels its native-lite
prefix specimen separately from its explicit public Responses translation.
Both verify against their own offline captured JSON; neither proves equality to
a native process or provider acceptance. The single patch schema is a source
fidelity specimen, **not** a complete effective GPT-6 tool registry.

**Design implication.** Preserve exact rendered text using
`importText({text,origin,spans?,label?})` → `snapshot` → semantic serialization /
rehydration. Use a versioned `consumerOperation` / `lowerOperation` adapter and
`captureWire` / `verifyWire` at the host transport boundary. Keep native tool
JSON in consumer params: the convenience tool snapshot projects JSON functions
and cannot represent the complete grammar/namespace/hosted surface. The
[source inventory and Mermaid comparison](../../spikes/041-hp-codex-fidelity/README.md#source-inventory-and-execution-comparison)
cover the
[world-state renderer](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/session/world_state.rs),
[turn loop](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/session/turn.rs#L164),
[tool selection](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/spec_plan.rs),
steering queues, skills/MCP, compaction and child history/config inheritance.
These host/runtime behaviors remain parity gates; this spike implements prompt
storage/delivery fidelity rather than their runtime.

**Reproduce.** From `experiments/`, run
`AIUI_PROMPTS_CHECKOUT=/path/to/pdum_aiui pnpm --filter @agent-spike/041-hp-codex-fidelity test`
and the same filter's `probe`, `typecheck` and `build` scripts. Use the
[pinned vendor checkout](../../vendor/README.md). A local checkout is explicit
research input because the package lookup returned npm 404 in this environment;
there is no new package-local environment. The probe writes ignored
`artifacts/041-hp-codex-fidelity/summary.json`, semantic operations, offline wire
records, a 23-file source hash inventory and browser ESM. Summary fingerprints
record instruction role/location, input ordering and tool framing independently.

**Versions / limits.** Codex `6c372fbef45f730b6d8aa727b0ec8332365588db` clean;
aiui `217f6d731c07e36586349aaf6feb2310d1d2b9bf`, prompts `0.21.0+dev`, package
clean but repository dirty from unrelated pencil edits. Node 26.10.0, pnpm
11.9.0, TypeScript 7.0.2, tsx 4.23.15, esbuild 0.28.2. No native captured-request
diff, dynamic code-mode tool-description generation, stable native UUID metadata,
complete world-state renderer or live compatibility proof. Spend: zero requests,
USD 0 estimated; no subscription billing claim.
