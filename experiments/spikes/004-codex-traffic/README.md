# Codex app-server traffic experiment

This spike drives the executable's newline-delimited JSON protocol directly. There is no Codex SDK dependency. It reuses Spike 002's mitmproxy addon through a tiny local adapter that additionally redacts account identifiers. Python dependencies share the root uv lock and constraint; TypeScript tooling uses the pnpm catalog.

## Commands

```sh
pnpm --filter @agent-spike/004-codex-traffic probe
pnpm --filter @agent-spike/004-codex-traffic probe --websocket
pnpm --filter @agent-spike/004-codex-traffic probe --live
pnpm --filter @agent-spike/004-codex-traffic typecheck
```

The default fixture provider uses `wire_api="responses"` and `supports_websockets=false`. The second command enables WebSockets for that provider. The live command keeps the built-in provider configuration, independently of the fixture flag; it observed WSS in the tested release. A model catalog is not proof of entitlement; the completed live turn is the access check.

`SPIKE_CODEX_BIN` can point at a release or local build. `SPIKE_MODEL` chooses a model; fixtures default to the `gpt-5.4` model configuration without contacting that model. Live mode now defaults explicitly to `gpt-6-luna`, without a more expensive fallback. The original live run used the then-selected catalog default, `gpt-6.1-sol`; [Spike 008](../../docs/spikes/008-luna-websocket.md) verifies Luna live and estimates cost. No live multi-agent task is requested.

## Experiment sequence

1. Make a private temporary home/config/work directory outside the checkout, and a private ignored artifact directory.
2. Launch a loopback mitmproxy with a run-local CA. In fixture mode, only `fixture.agent-spike.invalid` routes through the proxy to the local synthetic Responses server; other proxied destinations are blocked.
3. Launch one explicitly resolved Codex app-server executable with proxy variables in both cases, empty `NO_PROXY`, and `CODEX_CA_CERTIFICATE`. TLS verification stays enabled.
4. Initialize raw stdio. Live mode reads the existing auth file in memory and injects its access token/account ID through `account/login/start`; refresh requests are rejected. The original file is hashed before/after.
5. Start a regular thread and wait for `turn/completed` with completed status.
6. In fixture mode, start a second thread. Its synthetic model response calls the real `spawn_agent` tool. Capture the child's request and answer, verify its completion, and verify parent/provider metadata using `thread/read`.
7. Shut down app-server and helpers, then verify model and child exchanges were captured. Keep exact command/version/hash, the stdio event stream, semantic wire events, and a redacted result summary.

The local fixture is deliberately minimal and deterministic, not a general OpenAI emulator. It supports normal Responses SSE and WebSocket JSON frames, including masked/extended frames and delta requests carrying `previous_response_id`. Its answers and usage values are synthetic. The local HTTP origin is unencrypted, while the actual Codex→proxy connection is HTTPS/WSS; the live proxy verifies upstream TLS normally.

## Capture and interpretation

`level0.json` records invocation/environment and executable identity. `level1.jsonl` records raw app-server messages in both directions. `level2.jsonl` contains HTTP/SSE/WebSocket events from the shared capture addon. `result.json` records thread outcomes, child lineage, protocol counts, and capture assertions. `capture-stats.json` accounts for dropped wire events. All are ignored local artifacts, mode 0600 under mode 0700 directories.

Level 1 stops recording at 16 MiB and retains at most 20,000 messages for assertions; helper stderr retains at most 1 MiB per helper. Level 2 inherits a 32 MiB file limit and 1 MiB retained body limit from Spike 002. WebSocket frames are reassembled by mitmproxy before its hook, so large single messages and high concurrency are not globally memory-bounded. Unsupported HTTP encodings/non-JSON and non-JSON WebSocket bodies remain metadata/hash only. Fixture compression is disabled to keep the model request JSON directly inspectable. This capture is intended for bounded debugging.

The live run showed why both directions and ordering matter: a no-generation warmup established response state, and the later model request referenced it and sent additional input. Looking only at the last request would miss part of the effective context. Model/API usage, including cache reads, is visible in the response events. Packet capture and TLS-key export were not exercised in this spike.

The proof covers the model's HTTP clients and one local child inheriting the parent's provider. It does not establish interception of external tools, plugin/MCP subprocesses, socket-based tools, remote workers, or every auxiliary service. Environment proxy settings are routing configuration, not an egress firewall. The process snapshot is taken after turns finish; it cannot rule out short-lived subprocesses. Source inspection supplies the architectural evidence that local child agents run through the same thread manager.

## Source inspected

At `vendor/codex` revision `6c372fbef45f730b6d8aa727b0ec8332365588db`:

- `codex-rs/core/src/agent/child_config.rs`: `build_agent_shared_config` copies effective turn config/provider into the child.
- `codex-rs/core/src/agent/control/spawn.rs`: `spawn_agent_internal` starts the child through shared thread-manager state and delivers initial input.
- `codex-rs/core/src/thread_manager.rs`: `spawn_child_thread` delegates to the in-process thread creation path and shares the authentication manager.
- `codex-rs/core/src/session/mod.rs`: the submission loop is launched by `tokio::spawn`, so an agent thread is an async task, not a separate CLI process or dedicated OS thread.
- `codex-rs/core/src/client.rs`: parent-thread and subagent header construction.
- `codex-rs/http-client/src/custom_ca.rs`: custom CA environment precedence for HTTP and WebSockets.
- `codex-rs/websocket-client/src/dialer.rs`: proxy-aware WebSocket connection and `NO_PROXY` handling.
- `codex-rs/core/tests/common/responses.rs`: the minimal synthetic response event shapes used by upstream tests.

The runtime binary was installed release 0.162.1, not asserted to be built from that inspected commit. Repeating with `SPIKE_CODEX_BIN` records the selected executable separately.
