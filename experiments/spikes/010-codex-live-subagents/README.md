# 010 — Live model-driven subagents

The [one-page result](../../docs/spikes/010-codex-live-subagents.md) summarizes two real runs. This spike uses raw app-server stdio and reuses [004's MITM adapter](../004-codex-traffic/python/capture.py), which imports 002's bounded semantic capture. It does not use a Codex SDK or synthetic model responses.

## Reproduce

```sh
pnpm --filter @agent-spike/010-codex-live-subagents probe
pnpm --filter @agent-spike/010-codex-live-subagents probe --luna
pnpm --filter @agent-spike/010-codex-live-subagents typecheck
pnpm --filter @agent-spike/010-codex-live-subagents test
pnpm --filter @agent-spike/010-codex-live-subagents build
```

The first two commands spend live subscription usage. Requirements: root `pnpm install` and `uv sync --all-packages`, an existing `auth.json` at the invoking `CODEX_HOME` or `~/.codex`, and an entitled exact `gpt-6-sol` model. The second run also requires `gpt-6-luna`. `SPIKE_CODEX_BIN=/absolute/path/to/codex` selects another executable; otherwise the runner resolves `~/.local/bin/codex` to its actual file. There is no model fallback. The independent `verify` command makes no network calls:

```sh
pnpm --filter @agent-spike/010-codex-live-subagents verify /absolute/path/to/run
pnpm --filter @agent-spike/010-codex-live-subagents analyze /absolute/path/to/run
```

The host starts only one parent thread and one parent turn per run. The prompt asks the model to emit exactly two `spawn_agent` calls, use fresh context, delegate arithmetic and alphabetical sorting without any tools or further delegation, wait, and report the two prescribed one-line answers. In inherited mode it requests omitted model/effort overrides. In Luna mode it explicitly requests `model: "gpt-6-luna"` and `reasoning_effort: "low"`. The host does not create child threads or inject their replies.

Fresh private HOME/CODEX_HOME/cwd directories sit outside the repository. The source access token and account ID are read once and passed in memory through experimental `chatgptAuthTokens`; normal credentials/config are not copied or changed. The original auth file hash is checked afterward. Refresh and approval callbacks are rejected. Proxy CA trust is process-local. Apps/plugins/bundled skills are disabled, approval is `never`, filesystem sandbox is read-only, thread count is bounded to three and depth to one. These tasks perform no shell or external-site requests.

The watchdog ends the process after three minutes or observed standard API-equivalent cost above $0.20 per run. This is a delayed observational limit, not a provider-side budget: outstanding requests can overshoot it. Unknown models/tiers terminate rather than silently receiving a made-up price. Captures have 8 MiB per message/body, 96 MiB Level 2, and 32 MiB Level 1 bounds. Verification rejects drops, truncation, malformed capture records, undecoded WebSocket bodies, HTTP body decode errors, unmatched model requests, or unpriced responses. Interrupted runs are partial evidence, not a successful result.

## Evidence and an initial harness error

Observed 12 October 2026, macOS arm64; Codex `0.162.1`, Node `26.10.0`, Python `3.14.7`, mitmproxy `12.2.3`. Binary identity and SHA-256 are in `level0.json`. Source inspection is pinned separately to `6c372fbef45f730b6d8aa727b0ec8332365588db`; it is not asserted to be this installed binary's exact commit.

| Run | Private artifact directory | Generating responses | Warmups | Capture size |
| --- | --- | ---: | ---: | ---: |
| Sol children | `artifacts/010-codex-live-subagents/1791817979214-inherit/` | 7 | 3 | 1,790,073 bytes |
| Luna children | `artifacts/010-codex-live-subagents/1791818129441-luna/` | 6 | 3 | 1,728,659 bytes |

The first model run completed successfully, but our postprocessor initially looked for `session_id` instead of the live `thread-id`/`session-id` HTTP headers. It then tried to read thread ID `undefined`. The raw evidence and persistent profile were intact. After correcting the parser, `recover` restarted the same isolated profile and issued only `initialize` and `thread/read` for the three real IDs. It recovered all three histories without another inference request:

```sh
pnpm --filter @agent-spike/010-codex-live-subagents recover \
  "$PWD/artifacts/010-codex-live-subagents/1791817979214-inherit"
```

`result.json` deliberately retains the initial error. `history-recovery.json`, `recovery-level0.json`, and `recovery-level1.jsonl` distinguish read-only recovery from the original run. Both artifacts subsequently pass `verify`, which writes `verification.json`. The Luna run completed its normal history export directly; no live retry occurred.

Every run retains Level 0 invocation, bidirectional Level 1 JSONL, decrypted semantic Level 2 JSONL, full app-server stderr, model catalog, exact prompt, parent/child `thread/read` snapshots, and analysis. Canonical rollout files remain in the retained private profile named by `result.json` and each history's path. Directories are mode 0700 and files 0600; artifacts are ignored. Authentication values are redacted. This is complete captured protocol evidence for these bounded runs, **not all network egress or fully decrypted application content**.

## What proves the child models?

1. The parent's Level 2 `response.output_item.done` records contain real `collaboration.spawn_agent` calls. Both use `fork_turns: "none"`; run one omits model/effort and run two sets Luna/low explicitly.
2. Each child opens its own upstream Responses WSS connection carrying `thread-id`, `x-codex-parent-thread-id`, and `x-openai-subagent: collab_spawn`. The child request's `model` and returned `response.model` both match the intended exact model. Parent requests/responses remain `gpt-6-sol`.
3. Parent history includes two `subAgentActivity` items with the selected child model. Child history links back through `parentThreadId` and contains one completed turn and the expected answer. The parent ends with both answers.

Child `thread/status/changed`, `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `thread/tokenUsage/updated`, and `turn/completed` notifications arrived automatically on the existing stdio connection, before any child `thread/read`. **Child `thread/started` was not emitted to that connection.** There were no host child starts or resumes. This is one-client evidence, not an assertion that every reconnect/subscription behaves identically. The pinned app-server listens for created threads and attaches all currently initialized connections; see [creation listener](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/lib.rs#L1298) and [attachment](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L3770).

**TLS interception is not universal plaintext recovery.** The `spawn_agent` argument `message` is application-encrypted ciphertext on the wire. Task name, model, reasoning effort, and fork mode are readable, as are the final answers. The ciphertext is retained verbatim after secret scrubbing, not decoded or replaced. The source treats normal tool-produced agent messages as encrypted; see [message conversion](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L62). Child UI history does not invent a plaintext initial user message that the protocol did not expose.

## Usage and estimated cost

Each row below aggregates **generating responses only**. Input includes cached input; do not add the two columns. Output includes any reasoning tokens, although these runs reported zero reasoning tokens. Cache-write tokens were zero.

| Run / actor | Input | Cached | Output | Standard API-equivalent USD |
| --- | ---: | ---: | ---: | ---: |
| Inherited: Sol parent | 53,497 | 31,360 | 190 | 0.05244600 |
| Inherited: arithmetic Sol | 10,180 | 0 | 10 | 0.02046000 |
| Inherited: sorting Sol | 10,184 | 0 | 12 | 0.02048800 |
| Override: Sol parent | 42,808 | 31,488 | 193 | 0.03086760 |
| Override: arithmetic Luna | 13,726 | 0 | 10 | 0.00137760 |
| Override: sorting Luna | 13,730 | 13,056 | 12 | 0.00020396 |

Generating responses total **$0.12584316**. Six `generate:false` warmups report another 55,012 input tokens and zero output, estimated separately at **$0.07548580** using standard rates. Combined illustrative total: **$0.20132896**. This is **not actual subscription billing**, and warmup billability was not established. Parent orchestration needed five model responses in run one and four in run two, so this is not a controlled model-cost benchmark.

On 12 October 2026, official short-context standard rates per million tokens were Sol $2 input / $0.20 cached / $2.50 cache writes / $10 output, and Luna $0.10 / $0.01 / $0.125 / $0.50. The analyzer subtracts cached/write tokens from regular input, prices each category once, associates created/completed response IDs, deduplicates completions, checks actual model equality, and rejects unsupported pricing contexts/tiers. All generating responses reported `service_tier: "default"`; warmups reported `auto`, for which the standard-price calculation is explicitly hypothetical. Every individual input was below 272K. Sources: [Sol pricing](https://developers.openai.com/api/docs/models/gpt-6-sol), [Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Runtime and model-selection boundary

The children are separate Codex conversation runtimes within one app-server process, implemented with asynchronous Tokio tasks; they are not fresh Codex CLI processes or guaranteed dedicated OS threads. [Child spawn](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/thread_manager.rs#L1968) reuses the shared auth manager; [session startup](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/session/mod.rs#L1018) uses `tokio::spawn`. Each runtime nevertheless creates its own observed model connection.

[Child configuration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/agent/child_config.rs#L204) starts from the parent's effective settings, then resolves explicit model/effort or configured subagent defaults. Explicit models must match the available catalog and support the selected multi-agent backend; effort is validated for that model. Selecting a new model without explicit/configured effort uses that model's default effort. Custom role configuration can apply additional settings. [The spawn schema](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L129) can hide model overrides through configuration. These are source findings, not additional live tests. See also [official subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Both probes deliberately used fresh context. They do not establish full-history-fork model override behavior, arbitrary provider mixing, automatic cost optimization, internet/tool egress capture, approval forwarding, or production reliability. They establish the narrower result: this installed version and account let a real Sol parent autonomously create two children, inherit Sol by default, or explicitly select Luna, with observable parent-child identity, model usage, and completion.
