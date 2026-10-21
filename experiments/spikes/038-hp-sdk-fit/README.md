# 038 — Can the Agents SDK own a Codex-like loop?

The later [048 edge pass](../048-hp-steering-edges/README.md) updates this
connector with steering receipts, effective-context insertion positions and
explicit connection discard. [049](../049-hp-control-integration/README.md)
qualifies the updated adapter with the shared runtime. The SDK fit decision
and original measurements below remain their own evidence.

**Recommendation:** use the official OpenAI Responses transport with a small
TypeScript runtime. Agents SDK 0.20.0 has useful primitives, but its current loop
cannot faithfully handle Responses steering or Codex custom/freeform tool calls.

Read the [result](../../docs/spikes/038-hp-sdk-fit.md) and
[implementation/evidence notes](details.md). This is experimental code, not a
production SDK. Authentication is an injected host responsibility.

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/038-hp-sdk-fit typecheck
pnpm --filter @agent-spike/038-hp-sdk-fit probe
```

`probe` runs real Agents/OpenAI SDK code against loopback WebSocket/HTTP peers.
The peers return scripted data. These checks establish client behavior, not
provider capability. They make no paid requests and require no credentials.

Explicit paid qualification, only after coordinating the round's spend:

```sh
node --env-file=../.env --import tsx spikes/038-hp-sdk-fit/src/live.ts
```

This uses **exactly `gpt-6-luna`**, standard service, reasoning `none`, at most five
generated responses, 256 output tokens per response, and 30 seconds per scenario.
There are no request retries or fallback models. `--steering-only` selects a
separate two-response targeted probe. The recorded investigation included one
parameter correction and one targeted follow-up; see the complete ledger.

Artifacts are local and ignored under `experiments/artifacts/038-hp-sdk-fit/`.
Each live run writes timestamped copies plus a latest summary. They can contain
provider messages and are not published evidence.

## Modules

- `src/connector.ts`: experimental native-item and model-event boundary shared with 039.
- `src/direct.ts`: model-round connector, preserving per-thread WebSocket continuation.
- `src/official-connection.ts`: Node adapter using public OpenAI SDK APIs and an injected client factory.
- `src/probe.ts`: Agents SDK function/custom tool, steering, context, and independent-run checks.
- `src/direct-probe.ts`: continuation, pending steering, unknown outcome, context replacement, and cleanup checks.
- `src/compaction-probe.ts`: public SDK manual-compaction adapter against local HTTP.
- `src/live.ts`: bounded provider qualification and usage recording.

A browser supplies a `ResponsesConnectionFactory` using its own authenticated
WebSocket constructor. `direct.ts` and `connector.ts` import no Node modules.
Tool execution, child-agent ownership, transcript storage, and user interface
remain outside this model-round connector.
