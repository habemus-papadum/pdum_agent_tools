# HP parallel tools

The [spike report](../../docs/spikes/050-hp-parallel-tools.md) describes the
question, implementation, nine portable edge cases and remaining boundaries.
The [052 integration run](../052-hp-work-integration/README.md) records real
Chrome execution and bounded model-selected parallel calls in Node and Chrome.

From `experiments/`:

```sh
pnpm --filter @agent-spike/050-hp-parallel-tools test
pnpm --filter @agent-spike/050-hp-parallel-tools typecheck
pnpm --filter @agent-spike/050-hp-parallel-tools build
```

Serve `dist/` and call `window.runHPParallel()` to run the identical cases in a
browser Worker. Model events in these cases are scripted, not provider evidence.
