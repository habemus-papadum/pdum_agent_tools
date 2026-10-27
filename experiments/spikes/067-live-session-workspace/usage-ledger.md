# 067 usage ledger

**25 October 2026.** Two explicit browser prompts, one per provider. Both asked
the agent to read `sample.txt` with a tool and report its marker/apple count;
neither requested file writes. No paid calls were made by subagents or by the
eight no-model backend checks. There were no paid retries or model substitutions.

| Provider | Input/cache/output evidence | Cost basis | Estimated USD |
| --- | --- | --- | ---: |
| Codex, `gpt-6-luna` | 36,970 input including 29,824 cached; 47 output | Native cumulative counters × saved 2026-10-17 list rates | 0.00103634 |
| Claude, `haiku` → `claude-haiku-5-5` | 4 uncached input, 32,469 cache-read, 7,510 cache-created, 120 output | Official SDK cumulative cost for one new conversation | 0.00188709 |
| **Total** | **Two successful user turns; no missing final results** | **Estimate, not measured subscription billing** | **0.00292343** |

Codex calculation uses the existing toolkit snapshot: `(36970−29824) × 0.0000001
+ 29824 × 0.00000001 + 47 × 0.0000005`. No new price lookup or live billing
inspection was performed. Claude's SDK records list-price cost basis and standard
service tier. Implementation-assistant execution costs are not available.

Ignored evidence lives under `experiments/artifacts/067-live-session-workspace/`:

- `qualification.json`: arithmetic, final status and usage metadata.
- `runs/735b1c89e0e548a3b867dc2034ee6c3d/`: Codex run metadata, live records and native history.
- `runs/d9bc87332b9b47a9963e0a72781576a8/`: Claude equivalents.

Both runs are ended. These records remain local, alongside the isolated profiles;
credentials and raw captures are not committed.
