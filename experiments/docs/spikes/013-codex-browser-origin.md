# 013 — Allowing a real browser to reach Codex app-server

**Question.** How difficult is it to patch the local Codex submodule so browser JavaScript can connect directly to its WebSocket app-server, despite the pinned upstream listener rejecting every `Origin` header?

**Result.** The narrow transport change is small: 63 inserted lines and two replaced lines in one Rust transport file, plus 92 lines of focused tests. It builds and works in a real browser. On **2026-10-12**, an isolated **Chrome 155** page opened the patched listener, received the real `initialize` response, and sent `initialized`. A second page on a different HTTP port failed the upgrade; Chrome's console reported **HTTP 403**. This demonstrates an **unauthenticated loopback listener**, not browser-compatible authenticated deployment or a model turn.

## What changed, and what stayed protected

The [patch](../../spikes/013-codex-browser-origin/browser-origin.patch) adds the deliberately spike-specific environment variable `CODEX_SPIKE_ALLOWED_BROWSER_ORIGINS`, read once at listener startup as a JSON array of exact canonical HTTP(S) origins. It accepts the opt-in only for a loopback listener. Absent configuration keeps the upstream browser denial. Unknown origins, `null`, wildcards, duplicate headers, and combined/multiple values remain denied; invalid allowlist configuration fails startup. Native clients without `Origin` keep their upstream behavior.

The existing `authorize_upgrade` call and upstream non-loopback authentication requirement are untouched. A separate capability-token fixture confirmed **401 without its token**, **101 with its token**, and **403 for an untrusted origin even with a valid token**. Origin checking is not identity: native clients can omit or forge the header. Every script on an allowed origin gains the corresponding local app-server access. Do not allow an origin serving untrusted content.

## Evidence and reproduction

- **6/6 focused Rust tests passed**, covering default rejection, exact matches, malformed configuration, duplicate headers, and non-loopback opt-in rejection. No full upstream suite was run.
- **12/12 real HTTP upgrade checks passed**, covering native/default behavior, allowlisting, invalid origins, and authorization preservation.
- **Two actual Chrome pages passed** their opposite expectations, rather than simulating a browser by adding an `Origin` header to Node's client. The positive page received the app-server's platform/user-agent response; the negative page never opened and received an error/close event. Browser JavaScript supplies its own `Origin`; the fixture cannot set it.
- Local evidence: [`build-result.json`](../../artifacts/013-codex-browser-origin/build-result.json), [`unit-tests.log`](../../artifacts/013-codex-browser-origin/unit-tests.log), and [`probe-GEM6Om/result.json`](../../artifacts/013-codex-browser-origin/probe-GEM6Om/result.json), with separate browser reports and child logs alongside. The browser tool's optional file export was unavailable; normal fixture reports persisted successfully. Its network-list view did not expose WebSocket headers, so this is not a packet/header capture claim.

With the existing [Spike 003 native baseline](003-codex-control.md) built, run:

```sh
pnpm --filter @agent-spike/013-codex-browser-origin build:native
pnpm --filter @agent-spike/013-codex-browser-origin probe
```

Open both URLs printed by the probe in a browser within four minutes. The runner records results and shuts down its children/listeners. [The runnable README](../../spikes/013-codex-browser-origin/README.md) explains applying/reversing the patch on a clean pinned checkout and manual launcher usage. Fresh homes, file-only credential storage, disabled plugin startup/remote control, and no account credentials keep this separate from the developer instance. There were no agent turns or model calls.

## Versions, effort, and limits

Source: `6c372fbef45f730b6d8aa727b0ec8332365588db` plus this patch; `codex-app-server --version` reports `0.0.0`. Host: macOS 26.6.2, Darwin 25.6.0 arm64; Node 26.10.0; Homebrew Cargo/Rust 1.98.1, not the upstream 1.95.0 pin. Focused tests took 163 seconds and the incremental standalone build 151 seconds using four jobs and Spike 003's target. No default toolchain was changed.

The patched binary lives at `artifacts/013-codex-browser-origin/codex-app-server` (SHA-256 `05c833158f9ae43b4c33ea33b1d1382f9b71328660f62294462d660ae29845df`). The baseline Spike 003 CLI's before/after SHA-256 stayed `3a64ffaeaa5814ab5bf9d3f705518714342cd30160c47f6d51e0ca7c21226952`; the installed developer CLI was untouched. The submodule intentionally has uncommitted source changes; the standalone patch file preserves them without changing its gitlink or publishing a fork commit.

**Assessment:** a small local experiment, not a difficult engine fork. Making the browser connection production-ready is a separate task: the browser WebSocket API cannot attach arbitrary `Authorization` headers, and this patch does not introduce cookies, token subprotocols, remote TLS, origin-aware authentication, or a browser-facing relay. Those decisions—and trusting/serving the browser application—are larger than the Origin check. Source anchors are [`app-server-transport/src/transport/websocket.rs`](../../vendor/codex/codex-rs/app-server-transport/src/transport/websocket.rs) and the unchanged [`websocket-auth/src/lib.rs`](../../vendor/codex/codex-rs/websocket-auth/src/lib.rs). This deliberately does not change conclusions about the **unpatched upstream** listener in [Spike 007](007-codex-protocol-guide.md).
