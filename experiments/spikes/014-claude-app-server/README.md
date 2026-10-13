# Claude app-server spike

Research implementation of the [proposal](../../docs/spikes/014-claude-app-server-proposal.md).
Read [results](../../docs/spikes/014-claude-app-server.md) and the
[architecture/work plan](../../docs/proposals/claude-app-server-architecture.md).
This is not a production app server or complete SDK compatibility layer.

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm spike:014
pnpm --filter @agent-spike/014-claude-app-server test
pnpm --filter @agent-spike/014-claude-app-server typecheck
pnpm --filter @agent-spike/014-claude-app-server build
```

Default probes initialize real isolated Claude workers and use genuine blocking
hook callbacks without inference. Storage tests use explicitly synthetic
transcripts. Failure-injection tests use a real local subprocess with a synthetic
protocol peer. They do not fabricate evidence of provider compatibility.

Explicitly opt into paid Haiku probes:

```sh
# Supply ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in your environment.
pnpm spike:014 --live
# Or explicitly select existing macOS Keychain login reuse:
pnpm spike:014 --live --keychain
```

No automatic credential lookup occurs without `--keychain`. That option reads
only the existing access token; it does not refresh credentials or copy normal
profiles. Values are never printed. Live comparison uses three queries with
USD 0.05 SDK-estimated budgets; storage adds four single-turn queries and concurrency adds two at USD 0.05.
The roughly USD 0.45 sum is a planning bound, not exact billing. Haiku 5.5 is
selected explicitly, output is bounded, and no model fallback occurs. Detailed
attempts and `cost-ledger.json` distinguish SDK estimates, price estimates,
unknown costs and actual billing.

`--skip-launch`, `--skip-storage`, `--skip-concurrency` and `--skip-manager`
select phases. The manager phase includes the actual process-restart probe. A fresh
ignored artifact directory records each run. `report.json` records failures and
unsupported scope; a failed check exits nonzero. Profile helpers and query state
are isolated from ordinary developer configuration. Only owned workers are stopped.

For the real browser probe:

```sh
pnpm --filter @agent-spike/014-claude-app-server probe:browser --block
# Optional live browser turn after explicit authentication:
pnpm --filter @agent-spike/014-claude-app-server probe:browser --live --keychain
```

Open the printed URL. `--block` runs a browser-hosted hook which prevents model
inference. The harness bundles the unchanged official browser export with an
empty `process` environment shim. Send input, interrupt, save evidence, then
detach. The foreground server stops on SIGINT/SIGTERM or after ten minutes.
The server retains native frame traces; the saved browser report shows which
frames the SDK exposes or consumes internally.

`manager.ts` owns a transport-neutral single-controller session policy.
`adapters.ts` contains WebSocket and stdio application-envelope adapters; these
are different from the raw SDK relay in `launch-probe.ts`. A fresh SDK instance
cannot resume its callback registrations simply by replaying application events.
History is currently in memory, with no durable manager-restart guarantee.
