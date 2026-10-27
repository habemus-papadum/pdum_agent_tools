# 071 — Official SDK over persistent Claude replay

Read the [report](../../docs/spikes/071-claude-sdk-replay.md). This tests the exact
installed official SDK against 068's unchanged thin server. It changes no
production launcher or SDK package. The older SDK/disconnect contract remains
implemented; this is evidence for the forthcoming client architecture.

## Files and boundaries

- `client.mjs`: the client-only envelope decoder and optional passive-control
  replay policy; input queue and probe helpers. It exposes original records.
- `no-model.mjs`: actual two-SDK control, duplicate hook execution on naive replay,
  connection loss and passive replay. Native hook blocks before inference.
- `live.mjs`: two official browser-export queries under Node share a real
  permission, reconcile its accepted decision with public SDK methods, and attach
  the official Node root export through the existing virtual-process adapter.
- `browser.mjs`, `build.mjs`: actual Chrome replay, follow-up, dropped connection
  and reload. No provider input on page load.
- `pending.mjs`: detach with an unanswered native permission, recreate the Query,
  re-arm it via initialization and answer through the SDK.
- `collect-costs.mjs`: rederive usage/price totals from the native journal without
  making provider calls; writes ignored `costs.json`.
- `PLAN.md`: original scope and limits.

The installed SDK is unchanged. Browser adaptation is deliberately confined to
the test realm: replace its WebSocket constructor with the decoder, and supply
the already-established empty process shim. This is not a production global
patch recommendation. The server continues to see and forward ordinary native
JSONL, without knowing about the SDK or callback reconciliation.

## Reproduce

From `experiments/`, start the existing 068 service with a new ignored root:

```sh
../.venv/bin/python spikes/068-claude-feed-replay/server.py \
  --root artifacts/071-claude-sdk-replay/no-model-owner \
  --host 127.0.0.1 --port 0
```

Set `SPIKE071_URL` to its printed HTTP URL, then:

```sh
SPIKE071_URL=http://127.0.0.1:PORT \
  pnpm --filter @agent-spike/071-claude-sdk-replay exec node no-model.mjs
```

That probe closes its worker. Stop the owning service by the PID it printed.
The corrected check observes Query completion and rejected further controls;
it does not require an iterator error that the tested SDK did not supply.

For explicit paid qualification, start a separate 068 owner with the supplied
ignored `--token-file artifacts/066-claude-setup-token/setup-token.txt`. The server
keeps this credential in its native worker environment; clients receive no token.
Then run `live.mjs --live` with `SPIKE071_URL`. It uses one fresh Haiku worker with
USD 0.05 native budget and three native turns per input. Probe queries have a
90-second AbortController deadline and state waits have shorter bounds;
the combined investigation ceiling was USD 0.50, aiming below USD 0.10.

The live script leaves the owned worker alive for the browser/pending follow-ups
and records its identity/URL in ignored `live.json`. Build with:

```sh
pnpm --filter @agent-spike/071-claude-sdk-replay exec node build.mjs
```

Serve that package's `dist/` directory on a separate local HTTP port. In an
isolated real browser, use its DevTools API:

```js
await sdk071.open('ws://127.0.0.1:PORT/sessions/RECORDED_ID/feed');
await sdk071.send();  // One actual Haiku follow-up; no tool call.
await sdk071.drop();
// Reload the page, then open the same URL, call control(), and close().
```

The pending-permission follow-up is `node pending.mjs --live` from the package
directory. It reads the same recorded URL and submits one additional tool input.
Do not repeat it merely to recheck the final report: saved evidence is sufficient.
Use fresh evidence directories and update the sample paths when doing a new
investigation so previous ledgers are not overwritten.

Finally POST `/sessions/ID/stop` to this owner, then terminate only the dedicated
owner/static-server PIDs. The existing mock preview on port 56044 is unrelated.

## Evidence and accounting

Ignored `artifacts/071-claude-sdk-replay/` contains:

- `no-model.json`, `no-model-client-records.json`, and native owner journals.
- `live.json`, `live-client-records.json`: actual dual-client permission behavior
  and Node root export attachment.
- `browser.json`: real Chrome follow-up, disconnect, reload and full replay.
- `pending.json`, `pending-client-records.json`: recovered question identity,
  successful native result and corrected pending-envelope inspection.
- `live-owner/…/profile/.aiui/running/…/feed.jsonl`: original pipe observations.
- `browser-readable.js`: formatting-only local copy used to inspect the installed
  public SDK implementation; not a modified runtime or committed dependency.

Three successful paid inputs used one native process. Its successive cumulative
costs were USD **0.00094786**, **0.00103697**, and **0.00126630**. Incremental costs
are USD 0.00094786, 0.00008911 and 0.00022933; never add the three cumulative totals.
All zero-model callback tests reported zero provider cost. The final pending
probe completed its model turn before a mistaken field-path assertion failed;
the original captures establish its successful outcome and no extra paid retry
was needed. Actual invoice and implementation-assistant costs are unknown.
Per-result input, cache and output counters and independent pricing are in
`costs.json`; the rates are the existing 17 October snapshot. Re-run
`node collect-costs.mjs` from this spike directory to check the arithmetic.

The SDK byte hashes are unchanged from 014:

- browser: `7f5d8dc0108929f15215b17e8bb4fbdb944d0ec4303e76c562643206988d0536`
- Node: `5cf6f15237f9c84e6e5b724a10180478732457168921d7aa3e02632037cce299`

Relevant installed declarations: `BrowserQueryOptions`, `Query.reinitialize`,
`Query.awaitControlResponse`, `CanUseTool`, `SpawnedProcess`, and `SSEOptions`.
Relevant distributed implementation: Query's control-message loop and callback
dispatcher, BrowserWebSocketTransport's close handling, and BrowserSSETransport's
hosted event decoder. No unsupported private method was called by the probes.
