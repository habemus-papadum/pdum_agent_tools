# 048 — Steering order, interruption and duplicate final events

This spike tests the portable 038 Responses adapter against real local WebSocket
connections using the public OpenAI SDK. The local peer scripts server events to
exercise failures and ordering. **These are client state-machine tests, not
provider compatibility evidence.** No API key or paid inference is used.

Read the [summary](../../docs/spikes/048-hp-steering-edges.md).

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/048-hp-steering-edges typecheck
pnpm --filter @agent-spike/048-hp-steering-edges test
pnpm --filter @agent-spike/038-hp-sdk-fit probe
```

The 048 suite has eleven bounded tests. The existing 038 suite remains a separate
regression check. Current pins: `openai` 7.38.0, `ws` 8.22.0, Node 26.10.0,
TypeScript 7.0.2 and pnpm 11.9.0. No production package or shared framework was
introduced.

## Contract changes

The existing model-round interface now has optional readiness and receipt fields,
so simpler connectors can continue returning their previous interface:

- `ModelRun.status`: opening, running, waiting for tools/successor, completed or
  failed. The response ID and running state are assigned before publishing
  `response.created`, so a notification handler can steer safely.
- `steer(input)` returns a local receipt after dispatch, never after provider
  acceptance. Its local receipt ID can be linked to the provider's steering ID.
- `ModelRun.steeringReceipts` returns snapshots. Sent, accepted and pending input
  becomes **unknown**, rather than rejected, after local abort or socket loss.
- `inputItem.index` supplies the canonical insertion location;
  `inputItem.receiptId` connects it to the accepted update. Consumers must splice
  at that index rather than always append.
- `ModelConnector.discardThread(id)` closes just that thread's transport and marks
  unresolved receipts unknown. The runtime calls it when a turn fails or is
  interrupted, including while a host tool is running between model rounds.
- Raw observations retain duplicate provider events with `duplicate:true` where
  identity is established. Derived final items, tool calls and usage are emitted
  once. Conflicting snapshots under one final identity fail visibly.

The runtime owns tool-result repair and user-visible input records. The adapter
never retries a tool or sends accepted steering again. A completed tool-call item
can survive an interrupted response; the next context must pair it with a
truthful aborted/not-executed or side-effect-unknown result before continuation.

## The ordering case

Suppose the model emits a tool call while provider steering A and B are accepted.
The host executes the tool; meanwhile the user adds local input C. The explicit
next request sends the tool result and C. The server prepends A and B to that
request. The canonical model context is therefore:

```text
prior response items → A → B → tool result → C → successor output
```

Appending A and B at the end would create a different replay context and can
cause a needless connection reset on the following turn. The adapter now stores
the old context-prefix boundary before sending the continuation and supplies
insertion indices when the successor is created. The test checks the resulting
context and the next request's exact delta, with one connection throughout.

Outgoing request capture intentionally excludes already-accepted provider
steering. A reconstructed effective-context view includes it after commitment.
Do not alter wire capture by resending those updates to make the two views look
identical.

## Tested edges

1. Two queued steers commit in submission order; startup readiness is observable.
2. Accepted/pending tool steering precedes tool results and later local input.
3. Provider failure before acceptance and failure after acceptance stay distinct
   local receipts; neither enters model context.
4. Socket loss before acceptance stays unknown and does not trigger replay.
5. Socket loss after acceptance also stays unknown.
6. Interruption during host-tool execution discards the cached socket and pending
   steering; a repaired next turn uses a new connection.
7. A completed tool item followed by interruption before the response terminal is
   retained; an explicitly repaired next turn is valid at the adapter boundary.
8. Repeated final item/terminal events do not duplicate tools or usage. Two equal
   text deltas remain two deltas.
9. Concurrent startup on one thread is rejected; discarding an unfinished factory
   returns promptly and closes any connection it eventually produces.
10. Conflicting data under a final item ID fails rather than being hidden as a
    duplicate.
11. Steering stops immediately on discard; an already-aborted run dispatches no
    request and reports failure.

Deduplication does not use message text. Final items use native item/call identity;
terminal usage uses response identity. A repeated steering event can use its
response target, event type and sequence number within the same connection.
Events without established identity remain in raw observations. This is not a
reconnect replay cursor or an exactly-once delivery guarantee.

## Source comparison and limitations

The official SDK's `ResponseSteerEvent` documentation states that accepted input
is prepended to an explicit continuation, in submission order. Its failed-event
documentation says loss or missing acknowledgement does not establish rejection.
The public WebSocket client union exposes create and steer; this implementation
does not invent a cancel-steer command.

Pinned native Codex source `6c372fbef45f730b6d8aa727b0ec8332365588db` provides a
useful reference:

- `core/src/context_manager/normalize.rs::ensure_call_outputs_present` pairs
  missing function outputs with synthetic aborted output inserted after the call;
  custom/local-shell cases have additional inherited-history invariants.
- `core/src/context/turn_aborted.rs` preserves explicit guidance that aborted
  commands may have partially executed and background processes may remain.

Those sources support the repair principle, not a claim of native recovery
parity. The outer runtime implements its own truthful execution-state records.
The adapter uses public APIs and native JSON items only; it does not inspect
opaque reasoning or private recovery formats.

The branch is still a prototype. The tests do not prove every upstream event
ordering, provider reconnection behavior, simultaneous writers on one connection,
or cancellation of server work after a local socket close. A parent-run integrated
live qualification should cover the runtime/adapter combination separately.
Paid calls in this spike: **0**. Estimated provider spend: **USD 0**.
