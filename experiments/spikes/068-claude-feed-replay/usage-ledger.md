# 068 usage ledger

**25 October 2026.** Six user inputs produced six successful Haiku results across
four isolated native processes. Total API-equivalent estimate: **USD 0.00283440**.
The two harness failures below are included. No result or cost is missing for the
submitted inputs. Actual subscription billing and implementation-assistant cost
were not measured.

| Run | Inputs | Harness outcome | Native result evidence | Estimated USD |
| --- | ---: | --- | --- | ---: |
| `20261025T164140-no-model-84356` | 0 | Nine checks passed | Real control messages only | 0 |
| `20261025T204216Z-live-84960` | 4 | Five checks passed; permission expectation timed out | Detached work, two queued prompts and harmless auto-allowed tool all completed | 0.00198087 |
| `20261025T204320Z-permission-88574` | 1 | Pending callback checks passed; wrong cancellation expectation timed out | Forced callback answered and native result completed | 0.00057840 |
| `20261025T204408Z-permission-89526` | 1 | Six checks passed | Reflected decision, ignored late answer, resolved replay | 0.00027513 |
| `20261025T204416Z-malformed-89684` | 0 | Native exit observed | Invalid JSON, no user/model prompt | 0 |
| `root-browser-smoke` | 0 | Two actual browser contexts passed | Initialization/error/idle-interrupt only | 0 |

Model alias `haiku` resolved to `claude-haiku-5-5` in every paid result. No model
substitution or automatic retry occurred. The combined live harness was bounded
to four inputs, two USD 0.05 native budgets and 160 seconds. Each explicit
permission follow-up used one input, a USD 0.03 budget and 80 seconds. Native
max-turns was three and output was bounded to 256 tokens per response for probes.
These bounds are not runtime product policy.

Total usage across the six result records:

| Counter | Tokens |
| --- | ---: |
| Uncached input | 20 |
| Cache-read input | 45,790 |
| Cache-created input, one-hour tier | 10,820 |
| Cache-created input, five-minute tier | 0 |
| Output | 421 |

The existing repository price snapshot is dated **17 October 2026**. Its Haiku
rates are USD 0.10/M uncached input, 0.01/M cache-read, 0.20/M one-hour cache-create
and 0.50/M output. These produce exactly USD 0.00283440, matching the sum of each
fresh process's maximum native cumulative cost. Do not sum cumulative costs of
successive turns within one process.

`collect_costs.py` re-derives these figures from the ignored report files, checks
agreement with native cumulative values and writes `artifacts/068-claude-feed-replay/costs.json`.
All four paid native processes stopped even when the harness timed out. Raw data
and credential references remain ignored; no credential value is in this ledger.
