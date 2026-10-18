# Spike results

Each spike has runnable code under `spikes/` and a short summary here. Generated evidence lives under the ignored `artifacts/` directory.

**Codex feasibility round, 2026-10-14:** read the
[combined findings](../../docs/codex-client-findings.md) for a high-level account
of spikes 025–034, their architectural implications and the shared usage ledger.
The individual reports below preserve exact protocol evidence and remaining limits.

**Claude checkpoint, 2026-10-13:** spikes 014–016 have a separately implemented
Python follow-up with qualified official browser/Node clients. Read the current
[handoff](../../docs/claude-handoff.md) and [qualification report](../../docs/claude-validation.md)
for completed work and remaining gates. Historical results below retain their
original scope, recommendations and cost ledgers.

## Tutorials

- [Authenticating Codex app-server to OpenAI](tutorials/codex-upstream-auth.md): upstream ChatGPT login, API keys, externally managed tokens, and workload identity federation. This is not client-to-app-server WebSocket authentication.

## Investigation plans

- [025–034 — Codex client feasibility](proposals/codex-client-feasibility-spikes.md):
  executed round covering history/replay, admin state, joining live threads,
  branching, remote files/processes, images, health, costs and observation plugins.
  The proposal preserves original questions; results distinguish tested behavior
  from the remaining subcases. No new client library was introduced.
- [014 — Claude Code app server](spikes/014-claude-app-server-proposal.md): compare launch strategies, reuse browser/Node SDK control logic and session helpers, and test shared clients, recovery, transport independence, and unmodified CLI compatibility. Implemented as a research harness; see the result and remaining live qualification gates below.

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
| 014 | Official SDK clients work through a direct relay; two raw controllers duplicate callbacks. The initial ownership recommendation is revised by 016. | [Claude app server](spikes/014-claude-app-server.md) |
| 015 | Native `agents --json` discovers running sessions; terminal `attach` uses a separate local supervisor/PTY transport. | [Claude session discovery](spikes/015-claude-agents-discovery.md) |
| 016 | Official browser SDK plus a small history/worker API supports shared profiles, live fork/resume and disconnect-ended sessions. | [Claude client sessions report](spikes/016-claude-client-sessions.md) |
| 020 | Async host-derived environments, a shell CLI, multiple commands and durable failure/cleanup evidence work in real namespace tests. | [Hostfork runtime](spikes/020-hostfork-runtime.md) |
| 021 | Prepared Btrfs snapshots preserve native tree behavior; overlays remain useful, and deletion differs from reclamation. | [Hostfork storage](spikes/021-hostfork-storage.md) |
| 022 | Shared services need explicit path semantics; 200 environments cleaned up, with Python helpers dominating overhead. | [Hostfork compatibility and scale](spikes/022-hostfork-compatibility.md) |
| 023 | Independent cgroup deadlines, CPU limits and real OOM reporting work; partial evidence survives several controller failures. | [Hostfork lifetime](spikes/023-hostfork-lifetime.md) |
| 024 | Python retains its subprocess handle while a systemd scope bounds library/native descendants; adoption must precede execution. | [Python-owned launch and scope deadlines](spikes/024-hostfork-scope.md) |
| 025 | Clean pinned source builds; 269 named messages versus 266 installed, with working runtime experimental gating. | [Version/source baseline](spikes/025-codex-baseline.md) |
| 026 | Native attachments support tags/notes; read markers work in the source build. Catalogue rows and search need reconciliation. | [Session administration](spikes/026-codex-session-admin.md) |
| 027 | History-only reads do not load an agent; legacy omissions and native output truncation prevent complete event replay. | [History and replay](spikes/027-codex-history-replay.md) |
| 028 | Multiple responders work; late joins can miss partial text, submissions are not idempotent, and work survives disconnect. | [Joining live threads](spikes/028-codex-joins.md) |
| 029 | Fork/revert affect conversation history, not files. Queue insertion and active-goal resume can start work. | [Branching and continuation](spikes/029-codex-forks.md) |
| 030 | Native file and streaming terminal operations work without inference, including through a real browser. | [Files and processes](spikes/030-codex-remote-operations.md) |
| 031 | Browser inline images work; local-image UI history depends on asset access, and HTTP image URLs are rejected. | [Rich input and assets](spikes/031-codex-rich-inputs.md) |
| 032 | Useful advisory health is possible, but idle turns can retain work and client events omit some failures. | [Health and swarm evidence](spikes/032-codex-health.md) |
| 033 | Shared accounting deduplicates replay/forks; native telemetry exposes costs missing from client counters. | [Usage and cost](spikes/033-codex-accounting.md) |
| 034 | Live client, launcher processor and offline analysis agree; local OTLP adds coverage. Hosted Logfire is untested. | [Observation and telemetry](spikes/034-codex-observation.md) |
| 035 | A read-only filesystem ingester answers every analysis question from DuckDB in milliseconds; read RPCs return identical items but no usage, model or fork lineage. | [Historical analysis paths](spikes/035-codex-analysis.md) |
| 036 | Both history files load into one MotherDuck database in 71 s with matching counts and bytes; simple queries answer in 25–80 ms, two writers commit concurrently, a thread replaces in under a second; substring search over the blobs is seven times slower than local. | [MotherDuck seed](spikes/036-motherduck-seed.md) |

For the current Hostfork direction, read the [architecture findings](../../docs/specs/hostfork/spike-findings.md).
Spikes 020–024 use only the Python research workspace and local Linux facilities;
they do not need the JavaScript setup or paid model calls. Run their commands from
`experiments/` after `uv sync --frozen --all-packages`.

From `experiments/`, install with `pnpm install` and `uv sync --all-packages`,
then run `pnpm spike:001`, `pnpm spike:002`, or `pnpm spike:003`. The third probe
requires the [vendor checkout](../vendor/README.md) and `pnpm build:codex` first;
this imported workspace has no Codex submodule.
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

`pnpm spike:014` runs credential-free Claude launch/control, manager and storage
probes; `--live` explicitly enables Haiku qualification. `pnpm spike:015` tests
native session discovery and terminal attachment without inference. The
[Claude architecture proposal](proposals/claude-app-server-architecture.md) organizes
the follow-up work around client-owned SDK queries and a thin relay.
`pnpm spike:016` runs credential-free profile/lifecycle probes; its separate
`probe:browser --live` harness exercises the actual browser flow with Haiku.

Capture terminology used by these experiments:

- **Level 0 — invocation:** versions, executable, arguments, working directory, selected configuration, and environment variable names; no credential values.
- **Level 1 — agent events:** the SDK's structured messages and control events. Whether these alone can restore or fork a session must be verified for each tool.
- **Level 2 — API traffic:** decrypted application requests, responses, stream events, and WebSocket messages where observable. This is distinct from packet capture.
