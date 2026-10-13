# 016: official client SDK sessions

Question: can clients retain the official SDK while a small host API manages
profiles/history and disconnect ends the native worker? See the
[report](../../docs/spikes/016-claude-client-sessions.md) and updated
[architecture proposal](../../docs/proposals/claude-app-server-architecture.md).

Run from `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm spike:016
pnpm --filter @agent-spike/016-claude-client-sessions test
pnpm --filter @agent-spike/016-claude-client-sessions typecheck
pnpm --filter @agent-spike/016-claude-client-sessions build
```

The default probe is credential-free: actual native workers, profile/settings
discovery, shared-profile controls, socket loss and manager shutdown. Tests cover
management isolation and accounting regressions, not fabricated successful
provider responses. The compiled build also includes its fixed-profile storage
helper. Runtime imports do not start a server or install signal handlers;
executable harness entry points own those actions.

For the real browser flow, start the server and open its printed URL in Chrome:

```sh
pnpm --filter @agent-spike/016-claude-client-sessions probe:browser --live --keychain
```

Click **Run browser flow** once. Four short Haiku turns test two independent
workers on one profile, streaming, list/read/rename, selected-message fork and
cold resume. The published browser SDK is bundled unchanged with an empty
`process` shim. Credential alternatives are an explicitly supplied
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` with `--live` and without
`--keychain`. Credentials stay on the host; browser responses never contain them.
The query budget is USD 0.05 per worker, max three turns, 256 output tokens;
these bound the experiment, not production usage policy or exact billing.
There is no model fallback. The harness exits after 15 minutes or SIGINT/SIGTERM.

The browser report and per-attempt cost ledger are saved under ignored artifacts.
Do not reload the page and run again against the same server: each automated
run expects fresh profile history. Start a new server for a new experiment.

For credential-free tab-close reproduction, omit `--live`, then in the test
page's console run:

```js
const s = await spike016.open("a", undefined, () => new Promise(() => {}));
s.input.push("Hold in the pre-inference hook");
// After spike016.report.sessions[0].callbacks records UserPromptSubmit, close the tab.
```

Inspect `GET /api/workers` from another client: the worker should become stopped.
The official SDK's real periodic keep-alive has a separate 58-second probe:

```sh
pnpm exec tsx spikes/016-claude-client-sessions/src/lifecycle-keepalive.ts \
  artifacts/016-claude-client-sessions/keepalive-new
```

Management routes: `GET /api/profiles`; `GET/POST /api/workers`;
`GET/DELETE /api/workers/:id`; `GET /api/profiles/:id/sessions`;
`GET/PATCH /api/profiles/:id/sessions/:sessionId`;
`POST /api/profiles/:id/sessions/:sessionId/fork`. Worker creation accepts
`profileId` and optional `resume`, and returns its raw SDK `websocketUrl`.
Profiles are host-provided objects in this spike; there is no profile-creation
interview or authentication setup API yet. Listeners bind all interfaces by
default, with the printed loopback URL for local testing.

One connected SDK controller owns one worker lifetime. A never-attached worker
remains waiting until explicit stop or shutdown. History remains available after
workers exit. No reconnect recovery, durable registry, native terminal bridge or
Remote Control integration is claimed.
