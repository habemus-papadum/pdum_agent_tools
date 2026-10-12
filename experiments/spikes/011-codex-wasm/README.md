# 011 — Browser WASM feasibility

This is a compile-and-host-binding spike, not a Codex implementation or model-quality benchmark. Its [one-page summary](../../docs/spikes/011-codex-wasm.md) separates actual compilation outcomes from architectural conclusions.

## Run

```sh
git submodule update --init vendor/codex
rustup toolchain install 1.95.0 --profile minimal --target wasm32-unknown-unknown --target wasm32-wasip1
pnpm --filter @agent-spike/011-codex-wasm probe
pnpm --filter @agent-spike/011-codex-wasm binding
pnpm --filter @agent-spike/011-codex-wasm typecheck
```

`probe` checks the actual vendored app-server/core libraries, without changing their manifests or source, and then compiles and exercises `src/host-websocket.rs`. `binding` skips the Codex checks. A probe exit of zero means it recorded the checks and the binding passed; inspect each `checks[].exitCode` to learn whether Codex compiled. The expected result at this pin is **three compilation failures**. A changed upstream result is useful evidence, not silently treated as success for a browser engine.

No new Cargo project, registry dependency, SDK, browser package, or independent lockfile is introduced. The Rust binding compiles directly with `rustc`; the Node orchestration uses built-in APIs. The repository remains primarily TypeScript, but this small `.mjs` runner avoids adding compilation dependencies merely to invoke Cargo.

`SPIKE_RUST_TOOLCHAIN` overrides the additional installed toolchain, not the user's default. The helper resolves its exact compiler through `rustup which` and sets `RUSTC`/`RUSTDOC`. This matters here: PATH points at Homebrew Rust 1.98.1, while `rustup`'s default stable is 1.90.0. An initial attempt without an explicit `RUSTC` mixed toolchains and reported a missing `core` crate; that was an environment setup error, **not** evidence against Codex. The corrected runs used the upstream-requested Rust 1.95.0 throughout.

Equivalent individual check, from this repository root:

```sh
RUSTC="$(rustup which --toolchain 1.95.0 rustc)" \
  CARGO_TARGET_DIR="$PWD/artifacts/011-codex-wasm/target" \
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
  rustup run 1.95.0 cargo check --locked \
  --manifest-path vendor/codex/codex-rs/Cargo.toml \
  --lib -p codex-app-server --target wasm32-unknown-unknown --jobs 2
```

The helper additionally enforces 180 seconds per command, kills the process group on timeout, caps combined stdout/stderr to the final 2 MiB, records truncation, and verifies that upstream `Cargo.lock` is unchanged. Its target output is isolated under ignored `artifacts/011-codex-wasm/target/` (about 173 MiB after these checks), not the 15 GiB native target from Spike 003. `build` does not run Cargo; root recursive builds remain quick. macOS/POSIX process-group cleanup is the tested runner environment.

## Observed runs

Final bounded capture: `artifacts/011-codex-wasm/run-1791818100483/`, 2026-10-12. `result.json` records revision, exact compiler path/version, targets, commands, limits, diagnostic excerpts, exit statuses, and the host-binding event sequence. Separate logs contain the retained compiler output; none were truncated or timed out. The first corrected run is `run-1791818015526/`. A deliberately nonexistent toolchain produced a structured `probeError` and exit 1 in `run-1791818111743/` without changing toolchains or source.

| Package | Target | Actual first substantive failure |
| --- | --- | --- |
| `codex-app-server` library | `wasm32-unknown-unknown` | Mio 1.2.0 explicitly rejects the target and reports missing native selector/TCP types |
| `codex-core` library | `wasm32-unknown-unknown` | Same Mio failure |
| `codex-app-server` library | `wasm32-wasip1` | Tokio 1.52.3 explicitly rejects the selected feature set |

The checks stop at the first dependency failures. They did not reach all C dependencies, every Codex crate, linking, or startup. Removing the first guard would not establish that the rest of the engine works. We deliberately did not patch away errors or set `tokio_unstable` and then pretend the behavior was supported. An in-process API or a replacement `main` would still build these libraries.

## Source couplings

All upstream source evidence below is pinned to `6c372fbef45f730b6d8aa727b0ec8332365588db`, not an inference from the installed 0.162.1 CLI:

| Boundary | Exact source | Porting implication |
| --- | --- | --- |
| Runtime features | [app-server/Cargo.toml:110](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/Cargo.toml#L110), [core/Cargo.toml:116](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/Cargo.toml#L116), [arg0/src/lib.rs:262](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/arg0/src/lib.rs#L262) | Native process/signal/standard-I/O/multithread runtime features are unconditional; the normal launcher builds a multithread runtime |
| Inbound transport | [stdio.rs:30](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-transport/src/transport/stdio.rs#L30), [websocket.rs:143](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-transport/src/transport/websocket.rs#L143), [in_process.rs:137](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/in_process.rs#L137) | Threaded stdio and TCP listeners are native, but an existing typed-channel embedding seam makes a new frontend transport plausible |
| Outbound model connection | [websocket-client/Cargo.toml](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/websocket-client/Cargo.toml), [dialer.rs:14](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/websocket-client/src/dialer.rs#L14), [connector.rs:32](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/codex-api/src/endpoint/responses_websocket/connector.rs#L32) | Tokio TCP, Rustls, proxy tunneling, and caller/auth headers differ from the browser WebSocket API |
| HTTP | [http-client/Cargo.toml](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/http-client/Cargo.toml) | Native TLS/certificate and compression dependencies remain even though reqwest itself has a browser backend |
| Command tools | [utils/pty/Cargo.toml](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/utils/pty/Cargo.toml), [child_command.rs:97](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/utils/pty/src/child_command.rs#L97) | PTYs, native commands, and process lifecycle need a remote/native host implementation or must be removed |
| Persistence | [thread-store/Cargo.toml](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/thread-store/Cargo.toml), [Cargo.toml:484](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/Cargo.toml#L484) | Native SQLite, rollout files, and blocking I/O require portable storage plumbing; the storage trait alone does not feature-gate the native implementation |
| Credentials | [login/src/auth/storage.rs:182](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/storage.rs#L182) | File/keyring ownership and renewal are host services, not browser equivalents of a developer's existing login |

## Tokio, HTTP, and WebSockets are different questions

Tokio documents a limited WASM feature subset: synchronization, macros, I/O utilities, the basic runtime, and time where the host supports it. Its unstable WASI networking is not a promise that native TCP creation or process APIs work in a browser. The vendored lock resolves Tokio 1.52.3; its downloaded source contains the same feature guard that the WASI compile hit. The current online documentation inspected was 1.53.2. [Tokio documentation](https://docs.rs/tokio/latest/tokio/#wasm-support).

Rust futures can instead be scheduled through JavaScript/browser integration. A browser-native implementation must arrange event-loop wakeups, timers, cancellation, and blocking-work replacements; using a worker does not automatically provide `std::thread`, Tokio's native I/O driver, or shell subprocesses. [Rust's browser-style target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) explicitly documents nonworking standard filesystem operations and thread spawning.

Reqwest 0.12.28 has a WASM implementation backed by browser Fetch; TLS and cookie behavior then belong to the browser, with a different configuration surface. That is evidence that Rust HTTP is possible, not that Codex's native HTTP wrapper is portable unchanged. [Reqwest WASM documentation](https://docs.rs/reqwest/0.12.28/reqwest/#wasm).

Likewise, `web-sys` exposes browser WebSockets through `wasm-bindgen`; the upstream example demonstrates open/message/error callbacks. Codex instead uses its patched `tokio-tungstenite` 0.28.0 plus Tokio TCP/Rustls. A browser transport would replace that boundary rather than opening a native socket from WASM. [web-sys example](https://wasm-bindgen.github.io/wasm-bindgen/examples/websockets.html), [Tokio Tungstenite API](https://docs.rs/tokio-tungstenite/0.28.0/tokio_tungstenite/).

The browser constructor accepts a URL and subprotocols, not an arbitrary request-header map. Codex's current model connector merges provider/routing headers and adds authentication before connecting. A compatible browser auth mechanism must be provided by the endpoint, or a trusted relay must add those headers. We did not test direct browser access, endpoint origin acceptance, or subscription authentication here. Fetch/SSE additionally depends on CORS; WebSocket origin checks are not the same as the HTTP CORS preflight mechanism. TLS trust, proxy choice, cookie policy, and response-header visibility are also browser-controlled. [WebSocket standard](https://websockets.spec.whatwg.org/#the-websocket-interface), [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol).

Do not put reusable subscription refresh credentials into a served web bundle to work around this distinction. The native engine or a trusted relay can retain credential ownership while the UI uses its own scoped authentication. No developer configuration or auth files were read by this spike.

## What the small binding proves

`host-websocket.rs` is a dependency-free `no_std` module with two imports. Calling its exported `start()` invokes host `open_socket`; the JavaScript open callback invokes Rust `on_open()`, which passes a string from WASM memory to host `send_text`. A real local WebSocket server echoes that text and the Node runner asserts the round trip within five seconds.

This proves that **Rust/WASM can initiate an outbound WebSocket through explicit JavaScript imports**. It does not compile Codex, use Tokio, demonstrate a Responses request, implement a general WebSocket server, or establish browser compatibility. The tiny server handles only its own short text fixture. Browser `web-sys` is supported by the cited upstream example, not by this Node-only run. There is no live-model substitute claim: the compile-target question needs no model call.

## Deployment choices and qualitative effort

The existing native WebSocket listener is not directly browser-compatible: [its middleware rejects every `Origin` header](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-transport/src/transport/websocket.rs#L89), as recorded in [Spike 007](../../docs/spikes/007-codex-protocol-guide.md). A browser-facing relay should validate its own origins and authentication, then open a separate trusted stdio/WebSocket connection to app-server. This is an **inbound control-plane** issue; the model WebSocket's outbound auth/header and endpoint-origin constraints are a different boundary.

| Choice | Assessment |
| --- | --- |
| Browser TypeScript UI → trusted relay → native app-server | **Focused integration.** Retains the CLI harness, native tools, auth, storage, and existing upstream update path. The browser need not contain Rust |
| Node host → native Codex process over stdio | **Focused integration.** Existing raw protocol avoids a WASM port; add process lifecycle and permission invariants |
| Native Rust host → `in_process::start` | **Moderate coupling.** Avoids stdio without changing target; the caller must manage native resources and track internal Rust API changes |
| Browser WASM frontend/parser only → native engine | **Focused to moderate.** Viable if Rust code sharing is valuable, but JSON-RPC already has TypeScript-friendly schemas |
| Actual engine inside browser WASM | **Large, multi-subsystem port.** Needs feature-gated dependencies, async host abstractions, storage/auth replacements, tool/PTY delegation, and an ongoing rebase/test strategy; unlikely to be justified merely by transport preference |
| Engine in a WASI runtime | **Separate port, not a browser shortcut.** The P1 check fails; P2/component-model work is untested, and host capabilities must still cover the engine's services |

Node's `WebAssembly` support supplies an execution engine, not automatic Node bindings for arbitrary Rust std APIs. Its WASI module currently advertises preview1/unstable interfaces; its documentation also warns that it is not a secure sandbox for untrusted code. WASIp1 explicitly lacks process spawning; WASIp2 is a different component-oriented target and runtime requirement. [Node WASI](https://nodejs.org/api/wasi.html), [Rust WASIp1](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html), [Rust WASIp2](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html).

A Codex permission setting cannot remove the browser's own capability boundary. For mathematical/scientific work needing Lean, compilers, arbitrary Python, or long-running infrastructure tasks, those native tools would still need a host or a remote execution service. Preserving them behind a native app-server is considerably closer to the project's goal of retaining the labs' harness engineering than replacing them during a browser port. This effort assessment is an architectural inference from the observed failures and source boundaries, not a measured implementation schedule.
