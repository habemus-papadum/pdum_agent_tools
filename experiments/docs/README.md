# Spike results

Each spike has runnable code under `spikes/` and a short summary here. Generated evidence lives under the ignored `artifacts/` directory.

## Tutorials

- [Authenticating Codex app-server to OpenAI](tutorials/codex-upstream-auth.md): upstream ChatGPT login, API keys, externally managed tokens, and workload identity federation. This is not client-to-app-server WebSocket authentication.

## Spike results

| Spike | Main result | Summary |
| --- | --- | --- |
| 001 | The SDK launches its bundled native CLI; configuration isolation requires explicit controls. | [Claude SDK launch](spikes/001-claude-sdk-launch.md) |
| 002 | A live subscription-authenticated Claude request was captured through HTTPS MITM as HTTP/1.1 + SSE; WebSocket capture was separately tested with a fixture. | [Claude traffic capture](spikes/002-claude-traffic.md) |
| 003 | Official SDKs and a rich app-server interface already exist; the personal fork builds and passes an isolated protocol probe. | [Codex control and build](spikes/003-codex-control.md) |
| 003 follow-up | Installed Codex accepts existing auth in isolation; MCP overrides differ by thread, while skill discovery is cwd-based and skill writes persist in the isolated home. | [Raw app-server isolation](spikes/003-codex-isolation.md) |
| 004 | Parent and spawned-child model requests traverse MITM over SSE and WebSockets; a live Codex request used WSS. | [Codex traffic](spikes/004-codex-traffic.md) |
| 005 | Dedicated auth homes and renewable bearer commands work; custom cloud thread storage needs Rust integration. | [Auth and storage](spikes/005-codex-auth-storage.md) |
| 006 | Fork defaults, cold resume, shared-thread overrides, and incorrect launch flags can explain permission changes; behavior differs by version. | [Permissions and sandbox scope](spikes/006-codex-permissions.md) |
| 006 follow-up | Runtime config writes change new-thread defaults, not existing thread model/policy or direct-command startup policy; CLI overrides still win. | [Runtime configuration scope](spikes/006-codex-runtime-config.md) |
| 007 | A five-minute architecture guide plus a searchable, versioned protocol inventory maps the proposed SDK layers. | [Protocol guide](spikes/007-codex-protocol-guide.md) |
| 008 | Live `gpt-6-luna` uses WSS; existing MITM captures both directions, and usage gives a sub-cent API-equivalent estimate. | [Luna WebSockets and cost](spikes/008-luna-websocket.md) |
| 009 | Live usage updates arrive between model/tool iterations; model overrides work per thread and turn, and turn overrides persist. | [Turn telemetry and model selection](spikes/009-codex-turn-telemetry.md) |
| 010 | A live Sol parent creates two real subagents; a prompt requesting Luna children produces actual Luna requests and responses. | [Live subagents and child model selection](spikes/010-codex-live-subagents.md) |
| 011 | Unmodified Codex fails browser/WASI target checks; a small Rust/WASM host-WebSocket binding works, but the engine needs a substantial port. | [Browser WASM feasibility](spikes/011-codex-wasm.md) |
| 012 | The CLI derives context remaining from usage events with a 12,000-token display baseline; replay explains why the small Luna runs display 100%. | [CLI context meter](spikes/012-codex-context-meter.md) |
| 013 | A small opt-in loopback Origin allowlist lets a real browser initialize app-server; default denial and existing authorization remain intact. | [Browser WebSocket patch](spikes/013-codex-browser-origin.md) |

From the repository root, install with `pnpm install` and `uv sync --all-packages`,
then run `pnpm spike:001`, `pnpm spike:002`, or `pnpm spike:003`. The third probe
requires `git submodule update --init --recursive` and `pnpm build:codex` first.
See each summary for the exact scope of its probe and the evidence collected.

Run `pnpm spike:004`, `pnpm spike:005`, and `pnpm spike:006` for the new fixture
experiments. They default to local synthetic model responses, not paid inference.
The permissions spike's executable default is described in its summary; the traffic
spike has explicit live/transport modes. Open the architecture guide with `pnpm dev:web`.
`pnpm guide:generate` refreshes its executable-derived inventory; it is not required
just to read or build the checked-in guide.

`pnpm spike:008` runs one **live** Luna turn through the existing MITM and reports
captured usage and an API-equivalent cost estimate. Going forward, inexpensive
live calls are preferred for protocol evidence; fixtures are supplementary.

`pnpm spike:006:config` probes runtime config updates without model turns.
`pnpm spike:009` runs live telemetry/model-override checks. `pnpm spike:010`
uses a Sol parent with inherited-model children; `pnpm spike:010 --luna` requests
Luna children instead. Both preserve private MITM and raw protocol evidence.
`pnpm spike:011` runs bounded Rust target checks and a local WASM binding probe;
read its summary for the separate Rust toolchain prerequisites. A successful
probe invocation records the expected target failures; it does not mean Codex
compiled to WASM.

`pnpm spike:012` replays the saved live Spike 009 usage events through the CLI's
context-meter formula; it makes no model calls. Its summary explains how to
provide another capture if those private artifacts are unavailable.

`pnpm spike:013` checks the patched native app-server and waits for two browser
pages to validate allowed/denied origins. Build the separate binary first with
`pnpm --filter @agent-spike/013-codex-browser-origin build:native`; see the summary
for the source patch and prerequisite baseline build. It makes no model calls.

Capture terminology used by these experiments:

- **Level 0 — invocation:** versions, executable, arguments, working directory, selected configuration, and environment variable names; no credential values.
- **Level 1 — agent events:** the SDK's structured messages and control events. Whether these alone can restore or fork a session must be verified for each tool.
- **Level 2 — API traffic:** decrypted application requests, responses, stream events, and WebSocket messages where observable. This is distinct from packet capture.
