# HP accounting and ingestion evidence

**25 October 2026.** Portable HP archive calculations, the existing Python
history writer, and the production TypeScript/DuckDB pricing calculation agree
for both real Node and browser runs. Moving the data between storage backends
does not create a second source or another charge. This lane made no model calls;
the shared live qualification supplied its saved archives.

## Measured round trip

Each real run exported a parent, a child and an earlier-boundary fork. We first
ingested its five-response seed, then its seven-response continuation into the
same isolated database. The seven records include one real compaction request
outside a conversation turn. A repeated import used the existing ledger and
reported zero changed units and one unchanged unit.

| Actual source | Input, including cache | Cache read | Cache written | Output | Responses | API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node filesystem archive | 25,852 | 18,183 | 3,954 | 229 | 7 | 0.00116208 |
| Browser IndexedDB archive | 25,792 | 25,604 | 140 | 169 | 7 | 0.00036284 |

The dated price snapshot is **17 October 2026**. These are observed-usage estimates,
not invoices. In each run the parent owns five response costs, the independent
child one, and the fork one. The fork's inherited turn remains readable but adds
no copied response charge. Totals agree among the portable `summarizeArchive`,
production `priceUsage`, and production `usage_events`/`USD_EXPRESSION` SQL.
Context occupancy remains `null`; cumulative input tokens are not a context meter.

Eight selected production invariants passed for each final database. The ninth,
`responses-without-turn`, intentionally reported **one failure**: the real compact
endpoint response has no turn. We retained that outcome and the original billing
scope instead of inventing a turn or concealing the check. The schema permits a
null turn ID; the invariant needs to recognize genuinely out-of-turn operations
before this adapter becomes production functionality.

## Storage-independent boundary

The calculation functions accept decoded `HpArchive` data. They neither open a
file nor access IndexedDB, localStorage, browser globals, credentials or a live
runtime. Filesystem and IndexedDB ownership belongs to the storage adapters.
`historyExport` converts a supplied archive into the existing schema's rows;
the Python bridge consumes that portable export after the host transports it.
This browser export crossed into the same Python ingestion path used for the
Node export. It is not a requirement that a browser's own storage be a filesystem.

The small addition to 039's history exporter is a structural `HistorySource`
input: `runId`, `snapshots()` and `usages`. Existing runtime callers still work.
070 supplies the stable archive source identity and snapshots to that existing
transcript conversion, then adds deduplicated usage and lineage evidence.
There is no dependency on the archive's current file path or storage key.

`sourceId` survives an owner restart, selected history fork and repeated export.
Native response IDs identify the actual model work inside that source; conflicting
actor, endpoint or counter evidence is rejected rather than silently choosing a
cost. The archive also retains the original run identity as provenance. A new
runtime ID does not make inherited responses new work.

## Existing infrastructure used

- `pdum.agent_history.base.BaseIngest`: scan/fingerprint, staging, source-scoped
  replacement, publication transaction, incremental ledger and lineage derivation.
- `pdum.agent_history.schema`: current **schema version 5**, unchanged. This is
  also the version targeted by the earlier HP exporter; a version migration was
  not needed for these rows.
- Production TypeScript `HistoryDb`, `CHECKS`/`runChecks`, `priceUsage`,
  `ratesFor`, `pricesCte` and `USD_EXPRESSION`: real database reading, invariant
  results and independent pricing checks.

The production config/CLI still accepts only its existing Codex/Claude source
adapters. `ingest.py` is an isolated experimental HP source adapter over the real
writer; it does not introduce an alternative persistent ingestor configuration.
It validates table/column/source ownership and converts transport timestamps to
the writer's native timestamp values. That conversion corrected an initial
Arrow type error before any rows were published.

The source supplies explicit `forked-from` links so the existing lineage derivation
retains the fork, and it preserves `copied-context` on inherited transcript rows.
The original native response ID remains on each cost row. Compaction uses
`origin='responses.compact'`, a null `turn_id` and its actual usage; its boundary
and applied/discarded disposition remain in the richer archive. Discarding a
compaction result does not erase the provider work that produced it.

## Validation and limits

Four pure/local integration cases run actual HP runtime/tool/child/restore code
with explicitly scripted usage. They cover observer duplicates, resume/fork
identity, original-versus-inherited work, missing/invalid/unpriced records and
discarded compaction. They establish accounting mechanics, not provider behavior.
The separate actual live archives establish the round-trip results above.

Missing response counters or unknown prices remain explicit. The portable summary
reports a known subtotal with `complete:false` and its missing/invalid/unpriced
identities. Its completeness refers to represented response evidence, never all
possible provider work or a subscription bill. The qualification SQL requires
reported input/output for pricing; it does not turn missing counters into zero.

The ingestion experiment uses one selected complete archive per logical source,
with one writer choosing the current revision. It does not qualify concurrent
archive writers, stale-revision conflict resolution, corpus-wide deletion,
old-format/six-month coverage, cloud publication or browser-direct DuckDB writes.
The native history files and this analytical database remain separate stores.
Production queries with unscoped joins or cross-source response attribution need
their own existing review; this study does not silently repair every query pack.

One useful extraction item is now concrete: production `pricing.ts` combines pure
pricing functions with a Node-only `writeFile` import for table refresh. The spike
uses a small portable, injected-rate calculation and checks it against those
production functions. Split pure pricing from Node refresh before sharing that
module directly with the production browser client. No production package changed.

Versions: Python **3.14.7**, DuckDB **1.5.6**, installed history package
**0.1.0+dev**, Node **26.10.0**; schema **5**, price snapshot **2026-10-17**.
Applicable integration contracts: RC-07/09/10/12, especially source identity,
missing-data coverage, timing/billing scope and continuation versus copied context.

## Reproduce without inference

Run from `experiments/`:

```sh
pnpm exec tsx --test spikes/070-hp-backend-parity/src/accounting.test.ts
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts --fixture \
  artifacts/070-hp-backend-parity/accounting-local
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts \
  artifacts/070-hp-backend-parity/node-live/continue-archive.json \
  artifacts/070-hp-backend-parity/node-accounting
pnpm exec tsx spikes/070-hp-backend-parity/accounting-check.ts \
  artifacts/070-hp-backend-parity/browser-live/continue-archive.json \
  artifacts/070-hp-backend-parity/browser-accounting
```

The fixture's reported hypothetical cost is not provider spend. The real-archive
commands require the ignored artifacts from the owning live study. They run no
models, do not change the saved archive, and use the root Python environment for
the existing writer. The checker imports production TypeScript by source path;
workspace dependencies and lockfiles remain separate.

Evidence is in ignored `artifacts/070-hp-backend-parity/`:

- `accounting-local/accounting-report.json`: scripted local run and actual DB.
- `node-accounting/seed-accounting-report.json` and `accounting-report.json`:
  seed/continued real Node history, same database.
- `browser-accounting/seed-accounting-report.json` and `accounting-report.json`:
  seed/continued real browser history, same database.

Each final report includes counts, costs, lineage, individual invariant outcomes
and duplicate-import behavior. Typechecking, four accounting tests, Python lint
and formatting checks passed. No paid work was launched by this accounting lane.
