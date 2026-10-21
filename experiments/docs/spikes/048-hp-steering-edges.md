# 048 — Steering and interruption edge cases

**Result, 18 October 2026:** the adapter now preserves provider steering order and
has an explicit way to discard a thread's connection during interruption. Eleven
local WebSocket fault tests pass, using the actual official OpenAI SDK. These
checks establish client behavior; they do not simulate proof of live provider
compatibility. No paid calls were made.

The most consequential correction concerns steering that waits for a tool
result. If updates A and B have already been accepted by the provider, and a
later local input C arrives while the tool runs, the next explicit request sends
the tool result and C. The provider places A and B **before** those new items.
The old adapter appended them at the end of local context. It now inserts them
at the previous context boundary, preserving both the native items and their
order. This matches the
[official steering contract](https://developers.openai.com/api/docs/guides/steering).

| Boundary | Implemented behavior and evidence |
| --- | --- |
| Startup | A response ID and running state exist before a `response.created` observer can send a steer. Earlier input can remain queued by the runtime. |
| Multiple updates | Local receipts distinguish individual submissions; provider IDs and commit events attach to the corresponding receipt. Accepted updates enter context in submission order. |
| Tool continuation | Committed updates carry insertion indices and receipt IDs. The test verifies the complete context and next-turn delta over the same socket. |
| Rejection versus interruption | Provider failure marks a receipt failed. Missing acknowledgement, socket loss or local abort leaves unresolved commitment unknown. No automatic resend occurs. |
| Interruption between model rounds | `discardThread` closes the cached connection even while the host executes a tool. A new turn cannot accidentally reuse the old socket or its queued steering. |
| Missing tool result | Completed native calls remain available for the runtime to pair with truthful interrupted/not-executed results. The adapter does not rerun tools. |
| Repeated final events | Native identities prevent duplicate tool dispatch and usage accounting; raw observations remain available. Equal text deltas remain distinct. Conflicting final snapshots fail visibly. |
| Canceled startup | The waiting run settles on cancellation even if its host factory is slow; a late connection is closed when it arrives. |

The runtime and model context remain separate from transport receipts. A visible
user update is not proof that the provider applied it. Likewise, wire capture of
a continuation excludes accepted steering because the provider inserts it;
an effective-context view adds it only when commitment is observed.

The native reference checkout supports the interruption approach:
`context_manager/normalize.rs` inserts missing function outputs after their calls,
while `context/turn_aborted.rs` warns that side effects may already have happened.
The TypeScript runtime's repair records remain its own implementation, with
additional custom-tool and execution-state handling coordinated in the runtime
spike. This is not native recovery emulation.

Versions: `openai` 7.38.0, `ws` 8.22.0, Node 26.10.0; native source revision
`6c372fbef45f730b6d8aa727b0ec8332365588db`. The adapter remains portable TypeScript.
Authentication and actual browser WebSocket construction stay with the host.

See the [runbook and exact cases](../../spikes/048-hp-steering-edges/README.md),
[tests](../../spikes/048-hp-steering-edges/src/edges.test.ts), and updated
[model-round interface](../../spikes/038-hp-sdk-fit/src/connector.ts).
Run from `experiments/`:

```sh
pnpm --filter @agent-spike/048-hp-steering-edges typecheck
pnpm --filter @agent-spike/048-hp-steering-edges test
pnpm --filter @agent-spike/038-hp-sdk-fit probe
```

Remaining limits: these tests do not establish durable recovery, a global replay
cursor, cancellation of server work after local disconnect, or every possible
upstream ordering. The integrated live runtime check is separate evidence.
