# 002 — Capture Claude Code's API traffic

**Question.** Can the TypeScript Agent SDK expose its invocation, normal event stream, and decrypted API exchanges, including streaming protocols, without changing the developer's CLI setup?

**Result.** Yes for the tested paths. A real subscription-authenticated Claude Code run completed through a local mitmproxy on macOS. Its model request was `POST https://api.anthropic.com/v1/messages?beta=true`, HTTP/1.1 with a **gzip-compressed SSE response**, not WebSocket. That is the observed proxied path; interception can affect protocol negotiation, so it does not establish the direct connection's protocol. Captured request JSON includes `system`, `messages`, `tools`, `metadata`, thinking/context options, and streaming settings. Separate local fixtures verified HTTPS trust, plain and gzip SSE, and bidirectional WebSocket messages. This does not establish coverage of every network connection or every Claude feature.

## Capture levels

| Level | Meaning | Artifact |
| --- | --- | --- |
| 0: invocation | Exact SDK spawn command/arguments, selected environment, executable version/hash, run mode | `level0.json` |
| 1: agent events | SDK structured events, including partial messages and result usage | `level1.jsonl` |
| 2: API exchanges | Decrypted HTTP headers, JSON bodies, incrementally decoded SSE events, WebSocket JSON messages | `level2.jsonl` |

These logs are observations, not a replacement for Claude's session storage or a proven resume/fork format. Probes disable session persistence.

## Reproduce

From the repository root:

```sh
pnpm install --frozen-lockfile
uv sync --all-packages --locked
pnpm --filter @agent-spike/002-claude-traffic probe
pnpm --filter @agent-spike/002-claude-traffic probe --live --keychain
```

The default uses a synthetic HTTPS endpoint and spends nothing. The explicit macOS `--live --keychain` mode reads the existing Claude login once, keeps its access token in memory, and passes it to the isolated child as `CLAUDE_CODE_OAUTH_TOKEN`. It neither copies a credential file nor implements refresh. Alternatively, supply `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and use `--live`. Runs use an empty working directory, isolated home/config, `settingSources: []`, strict empty MCP configuration, no tools, one turn, a 60-second deadline, and a $0.03 SDK budget threshold. See the [runnable spike and detailed limitations](../../spikes/002-claude-traffic/README.md).

## Evidence and environment

Observed 2026-10-12 on macOS Darwin 25.6.0 arm64, Node 26.10.0, Python 3.14.7, mitmproxy 12.2.3, Agent SDK 0.3.296, bundled native Claude Code 2.1.296. The live probe recorded three HTTP flows: settings (404), policy limits (200), and the model request (200); 12 SSE events; zero WebSocket messages; TLS 1.3 on the client/proxy connection; and a successful `SPIKE_FIXTURE_OK` result. SDK-reported usage was 401 input and 57 output tokens, with no cache reads/writes and a $0.000686 usage estimate, not an asserted subscription charge. Local evidence: `artifacts/002-claude-traffic/1791809210035-live/` (ignored).

The fixture assertions verify rejection without the run-local CA, redaction of headers/query parameters/JSON secrets, SSE arrival before response completion, gzip decoding and expansion limits, oversized-body truncation, bidirectional WebSocket capture, and disk-budget drop accounting. TypeScript typechecking passes.

## Limits and findings

The existing `lean-agents` proxy buffers whole responses, logs only JSON POSTs, lacks WebSocket hooks, and redacts only request `Authorization`. Its general proxy/CA approach works; its logger needs more coverage and streaming behavior. This spike streams without changing forwarded chunks and bounds retained body/event data and output files. It captures JSON plus identity/gzip/deflate SSE; non-JSON bodies, unsupported encodings, and binary WebSocket payloads are explicitly omitted. The live ancillary responses used Brotli, so their headers/size/hash were recorded but their bodies were not decoded. The model exchange was fully decoded.

Proxy variables are routing requests, not network confinement: subprocesses, direct sockets, `NO_PROXY`, loopback WebSockets, and alternate providers can escape or need separate handling. [Claude's network documentation](https://code.claude.com/docs/en/network-config) documents proxy/CA configuration and the loopback WebSocket exception. Disk/body limits do not bound total concurrency, and redaction is not a guarantee that arbitrary model text contains no secrets. All captures remain private local artifacts.

Raw pcap alone cannot decrypt TLS. Optional `--tls-keylog` makes mitmproxy emit secrets for later Wireshark decryption; fixture generation was verified, packet collection/decryption was not. This still needs the proxy and only covers its TLS connections. Native Claude's own key-export support was not established; SDK source removes `NODE_OPTIONS` before native launch. [mitmproxy's TLS guidance](https://docs.mitmproxy.org/stable/howto/wireshark-tls/) describes the key log. Linux is unnecessary for this experiment; proving complete process-tree egress coverage would be a separate isolation/capture spike.
