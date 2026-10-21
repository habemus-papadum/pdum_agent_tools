# 043 — Real context compaction, opaque reasoning and forks

**Result:** Luna accepted explicit `/responses/compact`; a fresh connection reused
both native opaque reasoning and a compacted context. Full transcript replay and
parent/fork isolation remained intact in the small inventory task.

Read the [summary](../../docs/spikes/043-hp-context-compaction.md) and
[detailed evidence and usage ledger](details.md).

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/043-hp-context-compaction typecheck
pnpm --filter @agent-spike/043-hp-context-compaction test
pnpm --filter @agent-spike/043-hp-context-compaction build
```

The three tests use an actual local HTTP peer and the 039 runtime with its
explicitly scripted connector. They establish adapter/state behavior, not live
model capability. The build checks that the adapter bundles for browsers without
Node imports. It does not make a browser provider call.

Explicit paid reproduction, after coordinating the round's spend:

```sh
node --env-file=../.env --import tsx spikes/043-hp-context-compaction/src/live.ts --live --reasoning-task
```

This run allows at most five generated responses and one explicit compaction,
using exact `gpt-6-luna`, `low` reasoning for ordinary responses, standard service,
1,024 maximum ordinary output tokens, and 60 seconds per API call. The compact
endpoint has no `max_output_tokens` or reasoning-effort parameter. Its planning
allowance is documented separately. Input-count requests check supplied context
before model calls; all model/compaction usage is recorded. No automatic retries
or model substitution occur. Omitting `--reasoning-task` selects the simpler
inventory fixture, which may produce no reasoning items.

Local generated data belongs under ignored
`experiments/artifacts/043-hp-context-compaction/`. Encrypted artifacts, raw
provider messages and full journals remain local. Printed summaries contain only
results, counts and cost estimates.

## Integration

`src/compaction.ts` exports:

```ts
const outcome = await compactIdleThread(runtime, threadId, authenticatedClient, {
  signal,
});
```

It uses the existing runtime's public `read`, `context` and `replaceContext`
methods. The returned provider window becomes the next model context unchanged.
The transcript and checkpoint stay separately inspectable. If the thread changes
while the network call is running, the result is marked `discarded`; paid usage
is still returned. The helper introduces no ownership lock or credential logic.

`outcome.usage` is a separate `responses.compact` accounting record. Persist it in
the caller's observation journal; do not invent a conversation turn for the cost.
`inspectContext` reports item types, opaque-item presence and serialized bytes.
It deliberately does not convert bytes or encrypted-content length into tokens.
