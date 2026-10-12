# 011 — Can the Codex engine run as browser WASM?

**Question.** Can we compile the actual Codex app-server/core to WebAssembly, replace stdio with a JavaScript bridge, and send model requests over WebSockets?

**Result.** **Not as a small transport adaptation.** The unmodified app-server and core fail a browser-target check in native networking dependencies; a WASI check fails Tokio's feature guard. A tiny Rust/WASM module successfully opened and used a host-provided WebSocket in Node, proving the binding primitive—not a Codex port. Keeping the engine native and controlling it through its existing protocol is the practical baseline.

## Observed experiment

| Bounded check | Result |
| --- | --- |
| `codex-app-server --lib`, `wasm32-unknown-unknown` | Exit 101: Mio 1.2.0 rejects this WASM target; unresolved native I/O types follow |
| `codex-core --lib`, `wasm32-unknown-unknown` | Same Mio failure, even without the app-server binary |
| `codex-app-server --lib`, `wasm32-wasip1` | Exit 101: Tokio 1.52.3 rejects unsupported WASM features |
| Dependency-free Rust/WASM → JavaScript host → loopback WebSocket | Compile and echo pass in Node; no Codex engine included |

No source patches, lockfile changes, credentials, or model calls. Rust 1.95.0 and both targets were installed separately through rustup without changing the default toolchain. An initial PATH-shadowing/missing-`core` error was corrected by pinning `RUSTC`; it is not counted as a target failure. Final cached checks took 0.6–1.5 seconds each; the first corrected browser check took 12.6 seconds. These are early failures, not an exhaustive porting inventory or proof that a large port is impossible.

## Why stdio is not the main obstacle

Source inspection finds unconditional `process`, `signal`, `io-std`, and `rt-multi-thread` Tokio features in both crates. Native TCP/TLS/proxy networking, terminal subprocesses, filesystem tools, SQLite/rollout storage, credential stores, and shutdown behavior require separate adaptations. There is already an in-process typed-channel API, so replacing the inbound transport is one of the easier pieces. [Pinned dependency and implementation evidence](../../spikes/011-codex-wasm/README.md#source-couplings).

For an **inbound browser UI**, the stock app-server WebSocket listener rejects every `Origin` header: use a trusted browser-facing relay/host bridge, not a direct browser-to-listener connection. This [Spike 007 finding](007-codex-protocol-guide.md) is separate from the outbound model-API constraints below.

- **Browser:** Rust can use `web-sys`/JavaScript WebSockets, but browser APIs do not expose arbitrary handshake headers or raw sockets. Codex attaches auth and routing headers to its native model WebSocket. A browser port therefore needs an explicitly supported browser-auth route or an authenticated relay; HTTP fallback separately faces CORS. This experiment did not test either against OpenAI. [WebSocket standard](https://websockets.spec.whatwg.org/#the-websocket-interface).
- **Tokio:** asynchronous Rust is not inherently incompatible with WASM, but Codex's selected runtime features are. Browser event-loop, timer, and blocking-work integration would require redesign, not merely a different scheduler constructor. [Tokio WASM support](https://docs.rs/tokio/latest/tokio/#wasm-support).
- **Node/WASI:** Node can provide richer host imports, while WASI supplies a different host ABI. Neither automatically turns native dependencies into portable ones. WASIp1 still lacks process spawning; WASIp2 was not compiled here. [Rust WASIp1 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html).

## Reproduce and decision

```sh
rustup toolchain install 1.95.0 --profile minimal --target wasm32-unknown-unknown --target wasm32-wasip1
pnpm --filter @agent-spike/011-codex-wasm probe
```

The probe uses two jobs, a 180-second limit per subprocess, and a 2 MiB retained log tail. `binding` runs only the small host-binding demonstration; `build`/`typecheck` only check JavaScript syntax. `SPIKE_RUST_TOOLCHAIN` selects an already-installed alternative. [Details and direct Cargo command](../../spikes/011-codex-wasm/README.md).

**Identity/evidence:** 2026-10-12, Darwin 25.6.0 arm64, Node 26.10.0, Rust/Cargo 1.95.0, source `6c372fbef45f730b6d8aa727b0ec8332365588db`. Final bounded capture: `artifacts/011-codex-wasm/run-1791818100483/`. Toolchain-prerequisite failure recording was also tested. No browser execution, WASI runtime execution, live model connection, or patched-engine build was claimed.

**Recommendation:** a TypeScript browser UI through a trusted relay to native app-server preserves the existing harness with focused integration work. Native Rust embedding is another option if process boundaries are undesirable. A genuine browser engine retaining scientific command tools is a multi-subsystem port plus remote tool execution, with substantial upstream-maintenance cost; consider it only for a compelling browser-local requirement, not to avoid writing a protocol adapter.
