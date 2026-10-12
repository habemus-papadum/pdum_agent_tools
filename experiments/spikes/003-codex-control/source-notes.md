# Codex integration choices: source inspection

Inspected 2026-10-12. These are engineering judgments from documentation and code inspection, not comparative runtime benchmarks. Only our pinned Codex build and bounded app-server probe were executed; the community SDKs and the official Python/TypeScript SDKs were not exercised against a model.

## Official interfaces

The [official Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) lists both TypeScript and Python SDKs. The [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes the richer bidirectional integration surface. The original premise that no rich local Codex interface exists is therefore false. SDK names conceal an important difference in what they wrap.

Source links below pin `openai/codex` at `6c372fbef45f730b6d8aa727b0ec8332365588db`, the same revision as our fork/submodule. Source manifests use development versions; package registries are separate evidence. On this date `pnpm view @openai/codex-sdk version dependencies --json` returned SDK `0.162.1` with `@openai/codex` dependency `0.162.1`; PyPI metadata returned `openai-codex==0.162.1` with runtime `openai-codex-cli-bin==0.162.1`. The checked-out Python manifest still says runtime `0.153.4`; do not mistake this source placeholder for the published release dependency. We inspected the checkout, not the published SDK archives.

| Interface | What inspection establishes | Assessment for this project |
| --- | --- | --- |
| Official TypeScript `@openai/codex-sdk` | `CodexExec.run` launches `codex exec --experimental-json`; thread objects start/resume jobs, stream structured events, accept images and options, and support AbortSignal cancellation. The child command receives one prompt rather than a continuing bidirectional RPC conversation. | Good, small official automation wrapper. Limited fit for an interactive pet needing mid-turn input, client tool callbacks, or approval conversations. |
| Official Python `openai-codex` | Launches `codex app-server --listen stdio://`; sync/async interfaces; thread start/resume/fork, turn streams, steer/interrupt, authentication and turn-ID event routing. Public high-level approval modes are `deny_all` and `auto_review`. A lower-level client has approval handlers. | Stronger control than the TS wrapper. A credible existing SDK, with API choices that still need testing against our pet interaction requirements. |
| Direct app-server | Bidirectional RPC, generated schema, persistent subprocess, server-initiated requests and streamed notifications. Our local TS client successfully initialized and executed a command. | Best starting boundary for our primarily TypeScript application. We can preserve the harness without maintaining Rust merely to obtain control. |

Evidence: [TS subprocess code](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/sdk/typescript/src/exec.ts), [TS thread code](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/sdk/typescript/src/thread.ts), [Python API](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/sdk/python/docs/api-reference.md), [Python launcher](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/sdk/python/src/openai_codex/client.py).

The Python launcher copies the parent environment and then overlays `CodexConfig.env`. That option is not an environment allowlist. An isolated wrapper should launch from a scrubbed parent environment or otherwise explicitly eliminate unwanted inherited variables. Our direct TS probe instead supplies a small child environment and isolated `HOME`/`CODEX_HOME`; it does not alter the developer's shell environment or credentials. Its successful no-auth run proves that configuration arrangement for these specific calls, not comprehensive isolation of every future feature or a security sandbox.

## Controls already in app-server

The pinned [RPC method declarations](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/common.rs) include:

- Thread start, resume, fork, read, list and compact; turn start, steer and interrupt.
- Command/file approval requests, user-input requests, dynamic tool calls, MCP operations and authentication.
- Token-usage notifications, including cached input usage in the [thread protocol](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- Experimental APIs for background terminal listing/termination, queues and additional thread settings. A client must opt into the experimental capability for gated methods/fields.

`thread/rollback` has been removed in this revision; `thread/revert` is the replacement for paginated threads. This is explicitly stated in the pinned [app-server README](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/README.md). That concrete change is a reason to generate types from the executable we actually run, not to rely on current web documentation or an independently updated bindings package.

These declarations are source evidence, not proof that each control meets our requirements. In particular, resuming persistent conversation state is different from restoring operating-system processes, background jobs, subagents, or external tool state after compute suspension. Quiescence detection and sleep/wake semantics need a separate experiment. Neither this probe nor an SDK quality assessment establishes mathematical/scientific task effectiveness.

## Community alternatives

Ratings describe fit and visible engineering evidence, not measured reliability. Their tests were inspected but not run.

| Project and inspected revision | Evidence and limitations | Relative assessment |
| --- | --- | --- |
| [codex-app-sdk](https://github.com/codex-app-sdk/codex-app-sdk/tree/38a5b42d34b5e6b12ba160a8f95303777a734cb0) | Typed method maps, server-request handlers, timeout/error routing, bounded diagnostics, subprocess shutdown, Electron/web bridges and Vue conversation components. Tests cover transport, concurrent turns, approvals and fork behavior; CI installs Codex `0.154.0`, matching its documented generated protocol. | Promising broad TS app implementation; substantially richer control than the official TS exec wrapper. Larger product abstraction and protocol lag make it an evaluation candidate, not a demonstrated drop-in foundation. |
| [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp/tree/202e66e63343ec4f5a5e35ab590251d813d129ca) | TS app-server adapter, generated types, `vscode-jsonrpc`, protocol scenario fixtures and e2e tests. Source package `2.2.2` depends on `@openai/codex ^0.160.1`; translates Codex events into ACP and optional extensions. | Strong candidate for an ACP client. The translation boundary may omit Codex-specific capabilities; direct app-server remains simpler for full control in this project. |
| [spdcoding/codex-python-sdk](https://github.com/spdcoding/codex-python-sdk/tree/310b9d942c4d2a05097a38200c03a820c0657bf2) | Source version `0.2.1`; sync/async clients, approval and user-question callbacks, policy hooks, steer/interrupt and tests. Much of the protocol is dictionary-shaped. Its `thread_rollback` still calls `thread/rollback`, which our upstream pin has removed. | Useful reference for interaction patterns. Less attractive than the official Python SDK as a baseline because we can already identify a version-compatibility failure. |
| [pwrdrvr/codex-app-server-protocol](https://github.com/pwrdrvr/codex-app-server-protocol) | Packages generated TypeScript types, versioned to CLI `0.153.4` in the inspected README; no runtime transport/client. | Useful type distribution, not an alternative SDK. Generate our own from the pinned binary when strict parity matters. |

Supporting source inspected: `codex-app-sdk/packages/backend/src/codex/client.ts`, `packages/backend/src/node/codex-stdio-transport.ts`, its CI and backend tests; ACP `package.json` and scenario fixtures; community Python `async_client.py`, tests and `pyproject.toml`. Local checkouts are ignored under `artifacts/003-codex-control/research/`.

## A Rust dependency or a fork

Rust embedding is possible. `codex-core` is a library, and the workspace includes an [in-process app-server client](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-client/src/lib.rs) with typed request/response handling, events and shutdown. The old [zed-industries/codex-acp Cargo manifest](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/Cargo.toml) concretely consumes `codex-core` and many related crates from a pinned upstream Git tag. It also carries dependency patches, illustrating some maintenance cost. Its README now redirects development to the newer TypeScript app-server adapter.

A new Rust consumer would have to pin the interdependent crates and their patch set, follow internal API changes, and satisfy Codex's helper-executable assumptions. We have established that libraries and an existing consumer exist; we did not compile our own embedding crate or establish a stable Rust SDK contract. A fork is appropriate when a needed behavior lives inside the harness: additional low-level tracing or a reproducible policy bug, for example. It is unnecessary merely to expose a rich TypeScript/Python control surface.

We created [habemus-papadum/codex](https://github.com/habemus-papadum/codex), a public fork of the public upstream, and pinned it as `vendor/codex`. No patches were made to it. The private experiment code stays in `agent-spike`. The next focused experiment can test steering, client tools, approval routing and lifecycle over this app-server before selecting which, if any, Rust changes earn their maintenance cost.
