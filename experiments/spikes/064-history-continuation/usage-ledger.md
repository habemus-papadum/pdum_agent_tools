# 064 / 065 usage ledger

**25 October 2026.** Six explicit browser inputs: four continuation checks and
two interrupted sleep-tool checks. Other agents' backend/lifecycle/UI checks
submitted zero model inputs. No model substitution or paid retry occurred.

| Study / provider / case | Uncached input | Cached read | Cache created (1h) | Output | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| 064 Codex / resume | 7,060 | 11,520 | 0 | 28 | 0.00083520 |
| 064 Codex / fork | 7,049 | 11,520 | 0 | 21 | 0.00083060 |
| 064 Claude / resume | 2 | 12,577 | 7,645 | 41 | 0.00167547 |
| 064 Claude / fork | 2 | 14,878 | 5,325 | 28 | 0.00122798 |
| 065 Codex / interrupt | 6,978 | 11,520 | 0 | 157 | 0.00089150 |
| 065 Claude / interrupt | 2 | 14,878 | 5,071 | 166 | 0.00124618 |
| **Total** | | | | | **0.00670693** |

Models were `gpt-6-luna` and `haiku`, reported as `claude-haiku-5-5`. Rates come
from the existing toolkit's **2026-10-17** snapshot: USD 0.10/M uncached input,
0.01/M cached read, 0.50/M output; Claude one-hour cache creation USD 0.20/M.
These are dated API-equivalent estimates, not actual subscription charges or
implementation-assistant costs. Interrupted turns still consumed reported tokens.

Accounting avoids charging inherited context history twice:

- Codex resume emitted a pre-input cumulative snapshot; its delta was priced.
- The selected Codex fork emitted no initial usage snapshot. It had one new
  response, so that response's `last` counters were priced; inherited totals
  were excluded. This is not a generic estimator for arbitrary fork traces.
- Claude's resumed cumulative cost was USD 0.00356256, including the earlier
  067 cost of USD 0.00188709. New per-turn usage prices to USD 0.00167547, exactly
  the difference. The fork's cost counter began anew in this selected case.
- Both new interruption conversations used their reported current usage. Native
  errors/cancellation are retained; they are not interpreted as zero-cost calls.

`collect_costs.py` reproduces the arithmetic from the ignored browser evidence
and run captures. Machine-readable totals live in ignored
`experiments/artifacts/064-history-continuation/costs.json`. The 065 zero-input
ownership probes and additional zero-input End-all browser check add no inference.
