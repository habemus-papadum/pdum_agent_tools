# 056 experiment usage ledger

**19 October 2026.** This investigation used source inspection and isolated local
app-server/shell probes. It did not authenticate, submit `turn/start`, or contact
a model provider. The configured provider endpoint was an unreachable loopback
address; no credentials were supplied. The fixture operations were native thread
administration and explicitly requested local shell commands.

| Attempt suffix under `artifacts/056-codex-inactive-lifecycle/` | Outcome | Submitted model turns | Provider spend |
| --- | --- | ---: | ---: |
| `run-1792421850552` | Full-history polling hit the teardown/read race. | 0 | $0 |
| `run-1792421923480` | Lifecycle reached inactive; assertion wrongly expected an empty-preview fixture in the ordinary list. | 0 | $0 |
| `run-1792421970119` | Explicit source filters did not override the empty-preview list exclusion. | 0 | $0 |
| `run-1792422014638` | Raw user-history injection did not populate the native user-message preview; listing assertion failed. | 0 | $0 |
| `run-1792422123147` | Full-history polling again encountered teardown. | 0 | $0 |
| `run-1792422178672` | Archive/unarchive fixture preparation did not remove the read-during-teardown race. | 0 | $0 |
| `run-1792422279861` | 18 checks passed: metadata polling, confirmation of unload, then full-history read/resume. | 0 | $0 |

**Total experiment provider spend: $0; no token-usage notifications.** There is
no model-pricing estimate to apply. Implementation/research-assistant usage is
not exposed to this experiment and is not included in that zero.

All attempts and their failures remain in ignored local artifacts. The final
probe records negative catalogue observations rather than suppressing them or
manufacturing a normal user conversation. Source investigation explains the
preview exclusion and identifies the likely teardown race; neither is presented
as proof of provider/model behavior. Upstream Rust tests were read, not executed.
