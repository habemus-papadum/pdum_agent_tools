# 033 — Shared accounting, with explicit gaps

**Observed, 2026-10-14:** one small, transport-independent computation can account
for observed usage in a client, launcher processor and offline capture reader.
Structured history API responses alone cannot reconstruct the same result: returned turns/items
lack the usage notifications, and client counters miss some provider activity.
The useful product is a cost estimate with stated coverage, not an invoice.

## What the real captures established

| Case | Result and implication |
| --- | --- |
| Ordinary tool loops | Two user turns in 027 produced six usage increments. They price to $0.00163042. Count model completions independently of user turns and tools. |
| Multiple clients/resume | Replayed cumulative snapshots are duplicates, not new spend. Offline accounting of 028's streaming/control run reproduces $0.00206748. |
| Forked history | 029's fork replays inherited counters with a new thread ID and an old turn ID. The analyzer treats the first snapshot as a baseline and counts only $0.00063094 of subsequent observed increments. |
| Children | 032's parent excludes the child's usage. Sum distinct observed threads, while separately excluding inherited fork prefixes. |
| Context recomputation | Compaction changed `last.totalTokens` without increasing cumulative counters. Do not price context size as another response. |
| Upstream/native telemetry | In 034, seven provider completions match seven native OTLP usage records. Only four ordinary generating completions appear in client cumulative counters. Two warmups and one compaction are additional. |
| Historical browsing | Structured turns/items have no usage/context series. A resumed thread can emit its latest cumulative state, but resuming can also activate work. Use recorded usage for historical accounting. |

In the controlled 034 run, client counters estimate **$0.00073458**. Upstream
traffic adds **$0.00025880** for explicit compaction. Two requests with
`generate:false` report a further **$0.00182980** at nominal token rates, but their
billability is unknown. Thus all reported tokens price to **$0.00282318**, whereas
the five generating completions price to **$0.00099338**. These are alternate
views of the same run, not amounts to add together.

Representative observed compaction sequence, with identifiers and fields shortened:

```json
{"id":"A:9","method":"thread/compact/start","params":{"threadId":"T"}}
{"id":"A:9","result":{}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"T","tokenUsage":{"total":{"totalTokens":20471,"inputTokens":20431,"cachedInputTokens":18944,"cacheWriteInputTokens":0,"outputTokens":40},"last":{"totalTokens":5929,"inputTokens":0,"outputTokens":0}}}}
```

The total counters were the same before compaction; the separate upstream
completion reported 10,272 input and 76 output tokens. Thus neither a zero
input/output `last` nor unchanged cumulative usage proves the operation was free.

Provider response IDs deduplicate captured responses. Native OTLP records in this
run lack those IDs; the comparison matches model/count multisets and the controlled
operation sequence. It does not prove universal cross-exporter deduplication.

## The research computation

[`analysis.py`](../../spikes/033-codex-accounting/analysis.py) accepts the original
client or relay envelopes. It tracks RPCs by connection/request ID, usage by
thread/cumulative counters, and items by thread/turn/item ID. Final items replace
started snapshots. It retains native usage alongside observed increments and
records uncertainty for a missing initial baseline, incomplete counters,
unknown prices and counter decreases. A counter drop is not silently treated
as a new billing epoch. This conservative behavior can undercount after a real
reset; the result says so.

Five deterministic regression tests cover duplicate snapshots, inherited
baselines, counter decreases, missing values and disjoint cache pricing. They
supplement replay of real captures. In 034, all **82 messages** produced identical
final usage/item/status results in the live client, an actual launcher processor
and a reader of the saved JSONL file. This demonstrates a reusable computation
boundary; it is not a complete health or transcript library.

Price evidence is dated **2026-10-14**, using
[Luna Standard short-context rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
and the [cache pricing definition](https://developers.openai.com/api/docs/guides/prompt-caching):

| Disjoint token class | USD per million |
| --- | ---: |
| Uncached input | 0.10 |
| Cache-read input | 0.01 |
| Cache-write input | 0.125 |
| Output, including reasoning output | 0.50 |

With inclusive input counts, subtract cache-read and cache-write input before
pricing uncached input. Cache writes replace that input price; reasoning is
already within output. Real runs had zero cache writes; the nonzero case is a
labelled test fixture. The tiny analyzer assumes this one tier/context band and
dates its prices. It does not qualify arbitrary models, Fast pricing, long-context
multipliers, image-specific tokenization or historical rate changes. Requested
and native effective model settings are labelled separately from provider response
identity. A general implementation needs per-response attribution and a versioned
price table before supporting mixed models.

## Reproduction and limits

See [commands and private evidence](../../spikes/033-codex-accounting/README.md).
This spike performs no new inference; it reuses 027–034 and is not another charge
in the round ledger. The [round overview](../../../docs/codex-client-findings.md)
accounts for each generating experiment once.

Installed Codex 0.162.1 on macOS arm64 supplies the live evidence; clean source
`6c372fb…` is separately identified in 025. Real upstream retry billing,
unreported interrupted work, subscription invoices, full mixed-model/tier
accounting and faithful historical cost without a capture remain unqualified.
Missing usage is unknown, never evidence of zero cost.
