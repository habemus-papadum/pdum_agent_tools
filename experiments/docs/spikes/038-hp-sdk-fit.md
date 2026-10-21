# 038 — Agents SDK fit for a Codex-like TypeScript agent

**Result, 18 October 2026:** use the official OpenAI Responses transport and own a
small agent loop. Keep the Agents SDK as a reference and a possible source of
selected adapters. Do not fork it or reach into its private WebSocket state.

The question was whether the official TypeScript Agents SDK could provide the
loop while preserving Codex-style tools, steering, context control, and
independent children. Authentication was treated as an existing host integration.

| Requirement | Evidence and result |
| --- | --- |
| Ordinary SDK agent | Live Luna turn returned `SDK_OK`; local SDK executed a function tool and continued with its result. |
| Steering | Direct Responses live call produced acceptance and an automatic committed successor. Agents SDK exposes no public steering sender; a local accepted → incomplete/steered → successor sequence failed at the incomplete event and did not consume the successor. |
| Codex freeform tools | Direct live call accepted a Lark grammar, emitted `custom_tool_call` for `apply_patch`, then accepted `custom_tool_call_output`. SDK can forward the declaration as provider data, but its converter treats that call as unknown and the runner does not execute it. Local one-turn test exhausted its turn limit. |
| Prompt/context control | SDK `callModelInputFilter` replaced both instructions and input in a local WebSocket test. Direct connector retains native input/output items. |
| Compaction | Public SDK manual-compaction adapter worked against a local HTTP peer and replaced its context store. This tests adapter behavior, not compression quality. Keep transcript storage separate. |
| Children | Two concurrent SDK runs with separate providers completed independently in local tests. Addressable identities, mailboxes, cancellation, history, and parent policy remain application work. |
| Raw events and accounting | SDK exposed raw model events and per-request usage; direct live probes recorded usage for each response, including incomplete work. |
| Host-supplied connection | Both accept an OpenAI client. The Agents SDK's built-in WebSocket transport constructs a global WebSocket with headers and exposes no per-instance socket factory. Our small connector accepts a factory, keeping browser credentials outside the runtime. |

Steering preserves already-produced output. In the successful live probe, the
original response completed three Moon facts, then the successor returned
`STEER_OK`. A user update is therefore not an undo operation. Acceptance is not
commitment: a tool call can leave accepted input pending until the client sends
the required tool result. These distinctions match the
[official steering contract](https://developers.openai.com/api/docs/guides/steering).
The local direct tests cover pending-tool continuation, non-steered incomplete
responses with queued steering, loss after acceptance, and abandoning a generator
before completion. The latter closes and evicts its connection so the next turn
cannot reuse stale state.

The bounded live investigation generated **six responses: 368 input and 325 output
tokens**, with no cached input reported. The dated API-equivalent estimate was
**USD 0.0001993**; actual billing is unknown. Three initial requests were rejected
for an unsupported reasoning setting and returned no usage. An initial steering
probe reached its 256-token output limit before commitment was observed; the
shorter follow-up established the successor. All outcomes are retained in the
[ledger and detailed notes](../../spikes/038-hp-sdk-fit/details.md).

Versions: macOS arm64, Node 26.10.0, pnpm 11.9.0, `openai` 7.38.0,
`@openai/agents` 0.20.0, its internal `openai` dependency 7.36.0, and `ws` 8.22.0.
The research workspace lockfile pins these independently of production packages.

Reproduce credential-free checks from `experiments/`:

```sh
pnpm --filter @agent-spike/038-hp-sdk-fit typecheck
pnpm --filter @agent-spike/038-hp-sdk-fit probe
```

See the [runnable spike](../../spikes/038-hp-sdk-fit/README.md),
[connection boundary](../../spikes/038-hp-sdk-fit/src/connector.ts), and
[source/evidence details](../../spikes/038-hp-sdk-fit/details.md).
This spike does not qualify browser credentials, long-running recovery,
compression quality, production concurrency, or SDK handoffs as independently
managed child agents. The combined runtime demonstration is tracked separately.
