# 070 — HP backend parity: storage, history and accounting

Read the [findings](../../docs/spikes/070-hp-backend-parity.md) first. This is
disposable working research, not a new production package. The user required a
storage architecture independent of hard disk and browser storage type.
The [slice plan](PLAN.md), [persistence notes](persistence-notes.md),
[accounting notes](accounting-notes.md) and [usage ledger](usage-ledger.md)
retain scope, evidence and deferred choices.

## Local checks

From `experiments/`, using its pnpm workspace and existing source-linked packages:

```sh
pnpm --filter @agent-spike/070-hp-backend-parity typecheck
pnpm --filter @agent-spike/070-hp-backend-parity test
pnpm --filter @agent-spike/039-hp-agent-runtime test
pnpm --filter @agent-spike/070-hp-backend-parity build
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts --fixture \
  artifacts/070-hp-backend-parity/accounting-local
```

The strict 070 project includes portable/runtime/browser code and its local CLI
helpers. `accounting-check.ts` is checked separately with the production project's
optional-property setting: it imports production source, where enabling the
research workspace's `exactOptionalPropertyTypes` exposes an existing unrelated
optional-error mismatch in `checks.ts`. The actual checker also runs against real
DuckDB; its expected out-of-turn invariant failure is documented, not suppressed.

```sh
pnpm exec tsc --noEmit --module NodeNext --moduleResolution NodeNext \
  --target ES2024 --allowImportingTsExtensions --strict --skipLibCheck \
  --exactOptionalPropertyTypes false spikes/070-hp-backend-parity/accounting-check.ts
```

The runtime gets only one small import seam (`restoreSnapshots`); 039's exporter
now accepts a structural history source. Other code lives in this spike. No
production schema/package was changed and no new dependency version was added.

## Live Node journey

These commands use the authorized ignored root `.env`. Alternatively supply
`OPENAI_API_KEY` in the host environment and omit `--env-file`.
Run from `experiments/`:

```sh
pnpm --filter @agent-spike/070-hp-backend-parity exec \
  node --env-file=../../../.env --import tsx live.mjs --live
# This is a separate Node process reading the first one's committed data.
pnpm --filter @agent-spike/070-hp-backend-parity exec \
  node --env-file=../../../.env --import tsx live.mjs --live --continue
```

The seed performs a tool turn, another fact, actual compaction and a child turn.
It commits through `FileBlobStore` and exits. The second process reads that store,
resumes compacted context, then forks the earlier completed-turn checkpoint.
Assertions cover recalled facts, unchanged source, new owner/fork identities and
zero repeated tool effects. Use a fresh `HP070_ARTIFACTS` directory for a new
investigation; retain prior ledgers rather than overwriting failed attempts.

Per-process host bounds: eight response creates, 256 output tokens per response,
120 seconds, default service tier, `gpt-6-luna` only, no retries. Compaction is one
separate bounded-time endpoint call. These are probe bounds, not runtime defaults.

## Actual browser storage and reload

Build first, then start the dedicated test host from `experiments/`:

```sh
pnpm --filter @agent-spike/070-hp-backend-parity exec \
  node --env-file=../../../.env browser-host.mjs --live
```

Omit `--live` for no-provider local checks. Open the printed URL in an isolated
Chrome context. This is a small test harness, not another polished interaction mock.
Run these operations through the page's DevTools interface:

```js
await hp070.call('local', {database: 'hp070-local-check'});
await hp070.call('seed', {database: 'hp070-live-check'});
```

Reload the page normally, destroying its original Worker. Then:

```js
await hp070.call('read', {database: 'hp070-live-check'});
await hp070.call('continue', {database: 'hp070-live-check'});
await hp070.call('transfer', {database: 'hp070-transfer-check'});
hp070.terminate();
```

`local` runs the same persistence scenarios in IndexedDB and actual MessagePort
attachment cases, with scripted provider events and zero model calls. `seed` and
`continue` run the same live TypeScript functions as Node. The small host only
serves files, attaches a credential to upstream WebSockets, forwards the compact
endpoint and records ignored evidence. Credentials are not serialized into an
archive or returned to the browser. `transfer` reads the completed Node archive
and stores its unchanged bytes through IndexedDB. Its sample host path assumes
the default `node-live` artifact directory.

Browser bounds: ten response creates, one compact call, 256 output tokens,
240 seconds beginning with the first live request, USD 0.10 observed-cost ceiling.
No inference occurs merely by opening the page. Stop only the dedicated host PID
reported by this invocation. The existing server on port 56044 is unrelated.

## Accounting and evidence

After the live archives exist, no additional inference is needed:

```sh
pnpm exec tsx spikes/070-hp-backend-parity/cross-store.ts
pnpm exec tsx spikes/070-hp-backend-parity/collect-costs.ts
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts \
  artifacts/070-hp-backend-parity/node-live/continue-archive.json \
  artifacts/070-hp-backend-parity/node-accounting
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts \
  artifacts/070-hp-backend-parity/browser-live/continue-archive.json \
  artifacts/070-hp-backend-parity/browser-accounting
```

The ingestion helper uses root `.venv` for the actual production writer; it does
not merge the Python or TypeScript workspaces. The separate stores under ignored
`artifacts/070-hp-backend-parity/` hold native provider captures, seed/final archives,
usage ledgers, database checks and browser qualification. `cross-store.ts` verifies
the reverse transfer: browser-generated bytes read through the filesystem adapter.
`collect-costs.ts` compares archive usage IDs with independently observed endpoint
records; it counts both compact responses and excludes inherited fork context.

Important entries:

- `node-live/`, `browser-live/`: seed/final archives, results and provider evidence.
- `browser-qualification.json`: final 22 IndexedDB checks, six attachment assertions,
  reload identities, cross-adapter transfer and retained catalogue.
- `node-accounting/`, `browser-accounting/`: actual incremental ingestion, SQL,
  pricing and invariant results, with one legitimate compact-without-turn each.
- `cross-store.json`, `costs.json`: cross-backend identity and usage reconciliation.

Ordinary saved histories and analytical ingestion remain separate. No automatic
pending-input replay, filesystem rollback, running-job resurrection, cross-tab
host or coordinator crash adoption is implemented. See the detailed notes before
extracting a production API.
