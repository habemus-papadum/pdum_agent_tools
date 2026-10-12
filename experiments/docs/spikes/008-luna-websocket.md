# 008 — Live GPT-6 Luna WebSockets and MITM cost

## Question and main result

Does `gpt-6-luna` actually use WebSockets through Codex, and does our MITM capture them? **Yes.** A live subscription-authenticated turn on installed Codex **0.162.1** completed over `wss://chatgpt.com/backend-api/codex/responses`. The existing Spike 002/004 recorder captured the decrypted JSON messages in both directions. No synthetic Responses server, inference POST or SSE fallback was involved.

## First observed run

- One TLS-upgraded model connection; **22 WebSocket messages: 2 client → server, 20 server → client**. Three ancillary HTTP GETs were also captured.
- Request and response both identified **`gpt-6-luna`**, not an inferred alias. The final answer was `REGULAR_OK`.
- The first `response.create` had `generate: false`. The generating request referenced its response ID through `previous_response_id`; recording both exchanges matters for reconstructing context.
- Generating response: **10,185 input tokens, 8,960 cached, 0 cache writes, 7 output**. Warmup separately reported 9,149 input, none cached, and zero output.
- Approximately 875 KB of Level 2 JSONL, with **zero recorded drops** and no truncated WebSocket messages. The developer's original auth file was unchanged.

Using [official Luna Standard prices](https://developers.openai.com/api/docs/models/gpt-6-luna), the generated-response API equivalent is **$0.0002156**; adding the warmup's separately calculated equivalent gives **$0.0011305 (0.113 cents)**. This is a spend sanity check, **not an invoice**: subscription billing and warmup billing are not established by these usage counters. See the [implementation notes](../../spikes/008-luna-websocket/README.md#pricing-and-validation-boundary) for rates and assumptions.

## What the code says

At source pin `6c372fbef45f730b6d8aa727b0ec8332365588db`, the built-in OpenAI provider sets `supports_websockets: true` in [provider configuration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/model-provider-info/src/lib.rs). [Client transport selection](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/client.rs) checks provider capability and session fallback state, **not a special Luna/GPT-6 model-name test**. It tries WebSocket Responses and can fall back to HTTP, disabling WebSockets for the remainder of that session. The inspected source is newer than the installed executable; the live trace independently establishes the tested release's behavior.

Thus WebSockets are the observed default path here, not a guarantee that every GPT-6 request in every client uses them. The app-server's inbound transport was stdio; that is independent of its outbound model WSS connection. The [official Responses WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode) describes this transport and its incremental state.

## MITM design implications

**No new WebSocket capture engine is needed.** We already record complete reassembled JSON messages, including unknown event types, in order per flow. They are not original packet/frame captures, and redaction/size limits mean the archive is not byte-identical or universally lossless. The next useful work is connection lifecycle/sequence metadata, explicit loss reporting, rotation/retention, offline context-chain reconstruction, and usage accounting keyed by response ID. Preserve HTTP/SSE handling for fallback. [Detailed design notes](../../spikes/008-luna-websocket/README.md#minimum-infrastructure-to-build-next) describe these boundaries and the remaining memory, compression, binary-body and privacy work.

## Reproduce and limits

Run **`pnpm spike:008`** after root pnpm/uv installation. It defaults to one live Luna turn and reuses Spike 004's isolated launcher/proxy; `SPIKE_CODEX_BIN` chooses another executable. `--capture <004-artifact-directory>` reanalyzes without another API call. Environment: macOS arm64, Node 26.10.0, Python 3.14.7, mitmproxy 12.2.3. No SDK. First capture: `artifacts/004-codex-traffic/1791816004525-live/`; analyzed result: `artifacts/008-luna-websocket/run-1791816147482/`.

This checks one short normal turn, not live subagents, multiplexed streams, reconnect recovery, every encoding, or all process-tree traffic. Root working instructions now prefer inexpensive live probes using Luna, with bounded spend and explicit usage reporting; historical fixtures remain available for deterministic regressions.

Validation: the new runner was also executed end to end for a second live turn, again capturing 22 WebSocket messages with no drops or fallback. It reported 10,183 input / 8,960 cached / 7 output tokens and $0.0011303 including the warmup equivalent. Result: `artifacts/008-luna-websocket/run-1791816177124/`, pointing to its underlying 004 capture. **Both live turns together: $0.0022608 API equivalent (0.226 cents), including both warmups.** Typecheck, build, and capture assertions pass; no additional live calls were needed.
