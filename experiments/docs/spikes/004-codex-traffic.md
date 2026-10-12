# 004 — Proxy Codex app-server and its subagents

**Question.** When a raw stdio app-server is launched behind a TLS-intercepting proxy, do normal threads and model-spawned subagents use that proxy? Can we retain their actual model exchanges?

**Result.** Yes for both tested transports. The real Codex executable completed normal and parent/child turns against deterministic HTTPS fixtures through mitmproxy, using HTTP/SSE and secure WebSockets. The child was created by a model-produced `spawn_agent` tool call. Its intercepted request carried `x-codex-parent-thread-id` and `x-openai-subagent: collab_spawn`; `thread/read` independently reported the same parent and provider. A minimal live subscription-authenticated turn also succeeded through the proxy and used **WebSockets**, with no HTTP/SSE inference fallback observed.

## Evidence

| Run | Observed traffic | Outcome |
| --- | --- | --- |
| SSE fixture | 5 Responses POSTs; 15 SSE events; client→proxy HTTP/2, proxy→fixture HTTP/1.1 | Regular, parent, and child completed |
| WebSocket fixture | 3 upgraded TLS connections; 28 JSON WebSocket messages | Regular, parent, and child completed |
| Live default provider | 1 WebSocket inference connection; 22 messages, plus 3 ancillary HTTP GETs | `REGULAR_OK`; original auth file unchanged |

The live endpoint was `wss://chatgpt.com/backend-api/codex/responses`, using account access injected through experimental `account/login/start` with `chatgptAuthTokens`. Model selection resolved to `gpt-6.1-sol`. The WebSocket conversation began with `response.create` and `generate: false`, then a generating request referencing `previous_response_id`. The generating response reported 10,873 input tokens, including 9,600 cached, and 7 output tokens. The warmup separately reported 9,841 input and zero output tokens. These are recorded API usage values, not an inferred bill.

Observed 2026-10-12: Codex CLI **0.162.1**, Darwin 25.6.0 arm64, Node 26.10.0, Python 3.14.7, mitmproxy 12.2.3. Executable path/version/SHA-256 are recorded in Level 0. Source inspection used vendored revision `6c372fbef45f730b6d8aa727b0ec8332365588db`; this is separate from the installed binary's release identity. Initial successful artifacts: `artifacts/004-codex-traffic/1791814186273-{sse,websocket,live}/` (ignored).

## Reproduce

```sh
pnpm install --frozen-lockfile
uv sync --all-packages --locked
pnpm --filter @agent-spike/004-codex-traffic probe
pnpm --filter @agent-spike/004-codex-traffic probe --websocket
pnpm --filter @agent-spike/004-codex-traffic probe --live
```

Fixture runs require no credentials and incur no model usage. `--live` reads existing Codex authentication once and injects it through stdio without copying or refreshing it. Use `SPIKE_CODEX_BIN=/absolute/path/to/codex` to choose another executable; the default explicitly resolves `~/.local/bin/codex`. `SPIKE_MODEL` overrides model selection. Runs use a fresh home, `CODEX_HOME`, and working directory outside this checkout; disable apps/plugins/bundled skills and request compression; and terminate within 90 seconds. The live run requests only one short normal turn. The [implementation notes](../../spikes/004-codex-traffic/README.md) describe artifacts and bounds.

## Source explanation and limits

The inspected child-config code clones the parent's effective configuration and model provider. `spawn_child_thread` uses the shared thread manager, and `core/src/session/mod.rs` starts its submission loop with `tokio::spawn`: a local child is an **in-process Tokio task**, not a separately launched CLI or a dedicated OS thread. The completed fixture process snapshots showed no child OS processes, which is supporting evidence rather than a complete process trace. Both HTTP and WebSocket clients have proxy-aware paths and support `CODEX_CA_CERTIFICATE` (with `SSL_CERT_FILE` fallback); the tests pass only the run-local CA and never alter system trust.

This verifies model traffic for normal threads and one local model-spawned child, not all process-tree egress. Tools, MCP servers, remote agents, other providers, direct sockets, and `NO_PROXY` bypasses are not covered. The live run did not spawn a child; child behavior was proven with the actual harness against synthetic responses. Interception can affect protocol negotiation. Capture reuses [Spike 002](002-claude-traffic.md)'s bounded logger, including its documented non-JSON/unsupported-encoding omissions; raw WebSocket messages are stored in order, so warmups and incremental requests can be interpreted together. These logs are observations, not a session database.

An incidental constraint: ephemeral `thread/read` accepts metadata reads but rejects `includeTurns: true`. Child turn-completion events were observable even though this client did not receive a child `thread/started` event. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes the raw protocol and thread/turn lifecycle; the protocol and proxy conclusions above are observed behavior plus pinned-source inspection.
