# 070 usage ledger

**Observed 25 October 2026.** The Node and browser journeys each used five explicit
turns, six model responses and one compact response. All used `gpt-6-luna` with
default service tier. No paid retry or model substitution occurred. A preceding
model-metadata GET returned 200 and made no inference request.

| Host | Uncached input | Cache read | Cache write | Output | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node | 3,715 | 18,183 | 3,954 | 229 | 0.00116208 |
| Browser | 48 | 25,604 | 140 | 169 | 0.00036284 |
| **Total** | **3,763** | **43,787** | **4,094** | **398** | **0.00152492** |

The 17 October repository price snapshot supplies rates per million tokens:
USD 0.10 uncached input, 0.01 cache read, 0.125 cache write and 0.50 output.
All observed requests were within the short-context/default-tier pricing scope.
Inclusive input is split into uncached, cache-read and cache-write portions once.
The differing Node/browser cost reflects observed caching; these are not matched
cold-cache performance comparisons.

The total includes two actual compaction calls, even though those have no
conversation-turn ID. It includes child and fork work but does not charge again
for the fork's inherited transcript. Each archive's seven response identities
matched separately captured live endpoint evidence, and existing production
TypeScript pricing and SQL reproduced both totals. Repeated exports added no cost.

`collect-costs.ts` re-derives `artifacts/070-hp-backend-parity/costs.json` without
provider calls. Node's ordinary response ledgers and `compact-response.json`, and
the browser host's endpoint ledger, are retained separately from the saved archive.
Raw captures and credentials are ignored. Actual subscription billing and the
implementation assistants' own costs were not measured.

Local fixtures, storage/transport tests, browser reload/read/transfer, and ingestion
made no additional model calls. Early harness type errors and a timestamp-conversion
error in the experimental ingest adapter were fixed before their affected checks;
they incurred no provider spend. All four live phases passed on their first run.

The probe used existing bounded host helpers and explicit `--live` entry points;
the exact request/time/output bounds are in the [runbook](README.md). They do not
become product quotas. The dedicated browser host and Worker were stopped, both
Node processes exited, and ordinary profiles/shared services were untouched.
