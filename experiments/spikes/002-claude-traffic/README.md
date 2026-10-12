# Claude traffic capture probe

Run `pnpm --filter @agent-spike/002-claude-traffic probe` from the repository root after installing pnpm dependencies and running `uv sync --all-packages --locked`. The default creates a fresh private directory under `artifacts/002-claude-traffic/`, launches mitmproxy plus a local fixture origin, tests protocol handling, and executes the actual bundled Claude binary through the Agent SDK. The fixture is synthetic; its usage numbers and answer are deliberately fabricated.

For an actual provider request:

```sh
pnpm --filter @agent-spike/002-claude-traffic probe --live --keychain
```

`--keychain` is an explicit macOS-only read of the standard existing `Claude Code-credentials` item. The access token stays in process memory and the child's environment, and known-token scrubbing applies to emitted captures. It does not handle a nondefault credential service, expired credentials, refresh, or Keychain permission prompts. Stop this path if access is unavailable; use an explicitly supplied `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` with `--live` instead. Normal developer configuration and credentials are never written.

## Files and bounds

| File | Purpose |
| --- | --- |
| `src/probe.ts` | Proxy/fixture lifecycle, SDK spawn hook, Level 0/1 capture, bounded run and assertions |
| `python/capture.py` | mitmproxy addon; HTTP streaming callbacks, SSE parsing, WebSocket events, redaction and limits |
| `python/fixture.py` | Local JSON/SSE/gzip-SSE/WebSocket origin; proxy rewrites only the synthetic hostname to it |
| `python/check_fixtures.py` | Actual TLS/HTTP/WebSocket clients and compression/storage checks |

Directories use mode 0700 and files mode 0600 via explicit flags and umask. The proxy binds only loopback. Its CA lives in the run directory and is passed only as the child's `NODE_EXTRA_CA_CERTS`; there is no system trust-store change and TLS verification remains enabled. Fixture mode blocks non-fixture HTTP destinations inside the proxy, though it is not an OS egress sandbox. Live mode verifies upstream certificates normally.

Level 2 defaults to 32 MiB total output and 1 MiB retained encoded/decoded body data per direction. SSE events are logged as complete event frames arrive, across chunk boundaries, including gzip/deflate decompression. Oversized/incomplete JSON bodies are omitted with byte counts and a SHA-256; gzip expansion is bounded. Unsupported SSE compression is marked, not silently called decoded. Non-SSE JSON supports identity/gzip only. Non-JSON HTTP bodies and non-JSON WebSocket messages have metadata/hash only. WebSocket messages are already reassembled by mitmproxy before the hook; the code clears history after logging but cannot bound mitmproxy's single-message allocation. Response headers are always captured, including error statuses.

`SPIKE_BODY_LIMIT` and `SPIKE_FILE_LIMIT` customize the addon bounds, but the default fixture assertions intentionally assume the defaults. `capture-stats.json` records dropped events when the output budget is reached. Level 1 has an independent 8 MiB budget and drop counter. Helper logs have a 1 MiB budget per process. The small one-turn run has no global network-concurrency cap; synchronous JSON/file writes can add latency. Treat this as an opt-in debugging probe.

Authorization, API-key, cookie, token, and password fields are redacted in headers and structured JSON; URL secret query fields and the exact injected credential are scrubbed. This is not content classification: arbitrary prompt text, images, personal metadata, or secrets with unexpected names can remain. Do not commit any run artifacts. No mitmproxy raw `.mitm` archive is written because it would bypass this redaction.

## Lower-level capture and coverage

Add `--tls-keylog` to create a private `tls-keys.log` using mitmproxy's `MITMPROXY_SSLKEYLOGFILE`. A matching packet capture plus this file can support offline Wireshark TLS analysis. The file contains decryption material and is deliberately opt-in. The fixture checks that it is created; pcap collection and offline reconstruction have not been tested here. Packet capture may require macOS BPF permissions or Linux capture capabilities. A CA private key alone does not recover arbitrary modern forward-secret TLS sessions; session keys are needed. See [Wireshark TLS](https://wiki.wireshark.org/TLS) and [mitmproxy TLS key logging](https://docs.mitmproxy.org/stable/howto/wireshark-tls/).

`HTTP_PROXY`/`HTTPS_PROXY`, both cases, plus an empty `NO_PROXY` are explicitly passed to the child. Tools are disabled in these runs, so this does not test tool subprocesses. A process that ignores these variables can connect directly. Claude documents a loopback-WebSocket proxy bypass, and feature-dependent WebSocket traffic may exist even though this live inference used HTTP/SSE. No universal claim is made about Bedrock, Vertex, Foundry, remote agents, background supervisors, DNS, QUIC, or traffic outside this process. [Protocol support](https://docs.mitmproxy.org/stable/concepts/protocols/) and [streaming hooks](https://docs.mitmproxy.org/stable/addons/examples/) describe the proxy mechanisms.

Level 1 is an observed event log, not a supported session restore format. The SDK's own persistence/fork/resume APIs deserve another spike.

## Prior implementation inspected

Read-only comparison against `/Users/nehal/src/lean-agents` revision `17d95b268ab5c428d2efaac6f8ff466ae7b2bb9a` covered `src/lean_agents/proxy/{addon,env,proxy,certs}.py` and the Claude/Codex demo callers. Both demos route agent processes through the same proxy environment helper; the Claude demo also uses Linux namespaces/config overlays and Bedrock. This spike keeps the reusable proxy idea but uses a separate process and run-local CA on macOS. There is no dependency on that repository.
