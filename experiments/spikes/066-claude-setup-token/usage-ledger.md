# 066 usage ledger

**25 October 2026.** Costs are native SDK/CLI reported estimates, not measured
subscription billing. Implementation-assistant execution is not included.

| Run | Submitted inputs | Outcome | Reported input/output tokens | Reported USD |
| --- | ---: | --- | --- | ---: |
| `20261025T094036Z-no-model-44343` | 0 | Two SDK initializations, isolated commands and cleanup passed | No inference | 0 |
| `20261025T115609Z-live-70546` | 1 | Supplied token rejected; native authentication error | 0 / 0 | 0 |
| `20261025T115842Z-direct-71111` | 1 | Same token rejected by direct native CLI | 0 / 0 | 0 |
| `20261025T121749Z-live-79090` | 4 | Three successful Haiku replies, one intentional invalid-token rejection; all 11 checks passed | 900 uncached + 545 cache-created / 40 output | 0.000219 |

**Total: six submitted inputs; three successful responses, three authentication
rejections; USD 0.000219 reported estimate.** The no-model run submitted none.

The final run used `haiku`, resolved to `claude-haiku-5-5`. Successful result
records report 900 uncached input tokens, 545 cache-creation tokens (one-hour tier),
zero cache-read tokens and 40 output tokens. Each result's `usage` is per turn;
`modelUsage` and cost are conversation-cumulative. A's final cost was USD 0.0001681,
and fresh B's cost USD 0.0000509. Their sum is USD 0.000219; do not add A's earlier
USD 0.0000509 a second time. All rejected requests reported zero usage/cost, and
no result record is missing. Actual subscription billing remains unmeasured.

Original failed attempts remain in this ledger alongside the successful retry.
Raw run reports stay under ignored `experiments/artifacts/066-claude-setup-token/`.
