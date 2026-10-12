# 007 — Codex app-server architectural field guide

## Question and result

How should we organize the raw app-server protocol into a small, understandable SDK without losing the runtime’s capabilities? **Treat it as a bidirectional connection, not a request/response wrapper around a CLI.** The static [Vite guide](../../apps/web/src/main.ts) provides a five-minute architectural overview, an interactive example turn, expandable operational details, and a searchable inventory of every named message exported by the selected binary. This is a toolkit-design investigation, not an SDK implementation.

The proposed boundaries are an optional **Node process launcher**, a transport-independent **connection/RPC engine**, **admin and discovery**, a **thread registry/history layer**, and a per-thread **interactive session**. Host callbacks, event reduction, and recording/recovery cut across those layers. Process health, initialized transport, account authentication, and model readiness are separate states; there is no invented universal health RPC.

## Evidence and scope

On 12 October 2026, installed `codex-cli 0.162.1` exported **266 named messages** with experimental schemas enabled: 170 client requests, one client notification, 11 server requests, and 84 server notifications. The default export contains 105, one, 10, and 84 respectively. The [generated inventory](../../apps/web/public/protocol-inventory.json) includes names, top-level parameter/result fields, payload variants, experimental-surface labels, executable hash, and provenance. It contains public schema data, not captured conversations or credentials.

The guide explains request correlation versus thread/turn/item identity, initialization, asynchronous turn completion, callbacks, steering, interruption, errors, backpressure, subscription/lifecycle boundaries, and experimental/version drift. The pinned WebSocket listener rejects browser Origin headers, so browser UIs need a trusted host bridge; its HTTP health endpoints establish listener liveness only. Related findings from spikes [004](004-codex-traffic.md), [005](005-codex-auth-storage.md), and [006](006-codex-permissions.md) are explicitly version-qualified. In particular, release 0.162.1 and the newer source build differ on cold-resume permission restoration.

Primary sources: [official app-server documentation](https://learn.chatgpt.com/docs/app-server), [wire envelopes](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/rpc.rs), and [RPC declarations](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/common.rs). The source checkout is pinned at `6c372fbef45f730b6d8aa727b0ec8332365588db`, **not the installed release revision**. Schema fields come from the installed binary; source links and source-only experimental labels use that separately identified checkout.

## Reproduce

```sh
pnpm guide:generate
pnpm dev:web --host 127.0.0.1
pnpm --filter @agent-spike/007-codex-protocol-guide test
pnpm --filter @agent-spike/web build
```

The [generator](../../spikes/007-codex-protocol-guide/src/generate.ts) defaults to the explicit executable `~/.local/bin/codex`; override it with `SPIKE_CODEX_BIN`. It creates an isolated `CODEX_HOME`, executes only bounded version/schema commands, and saves generated schema trees plus binary metadata under ignored `artifacts/007-codex-protocol-guide/`. It makes no model calls. Environment: macOS arm64, Node 26.10.0, pnpm workspace, Vite 8.3.4, TypeScript 7.0.2. Binary distribution via DotSlash is a future launcher concern, not implemented here.

## Validation and limitations

Generator execution, TypeScript checks, and the production web build pass. Three automated tests cover inventory uniqueness and all 266 per-message explanations, search behavior, and distinct policy field names. Browser surfaces were unavailable, so no visual browser QA is claimed. The guide is local/static and makes no app-server connection.

Schema presence does not prove runtime support, permission, entitlement, or successful execution of a method. Nested schemas are referenced rather than recursively rendered. Default exports still contain some source-marked experimental notifications; the labels distinguish this from absence in the default schema. Regenerating schemas does not automatically revalidate prose or guarantee the newer source matches the binary. Existing runtime probes cover selected paths, not all 266 messages.
