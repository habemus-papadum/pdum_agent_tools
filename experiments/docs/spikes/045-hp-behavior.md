# 045 — Real coding work and model-selected application delegation

**Observed 18 October 2026:** HP and native Codex both completed the same small
JavaScript bugfix and passed all eleven independent gates. They received identical
prompts and projects, used Luna with low reasoning, and ran sequentially. HP added
and ran five regression tests; native Codex added and ran six. Both read the
required local skill and changed only the allowed source, tests and README.

| Recorded measure | HP | Native Codex |
| --- | ---: | ---: |
| Wall seconds | 25.68 | 23.35 |
| Model responses | 10 | 4 |
| Tool calls | 9 | 11 |
| Largest input | 9,960 | 13,345 |
| Output tokens including reasoning | 2,146 | 2,340 |
| Estimated API-equivalent USD | 0.002965455 | 0.003178000 |

This is evidence of useful coding behavior and a working comparison pipeline,
not a statistical ranking. Prompt framing, tool grouping and caches differ.
HP uses the pinned Codex prompt with public Responses and its own tool adapters;
the successful native arm uses complete installed Codex 0.163.0.

The first native arm used the source-pin build, which lacked its separate
code-mode host. Its error was preserved rather than treated as a quality loss.
Building that helper failed on an unavailable V8 archive; a fresh run with the
complete installed distribution succeeded. The harness now checks the helper
before inference. Four fake-executable regressions verify preflight, capture
failure and owned-process cleanup without provider calls.

**Model-selected delegation also passed in Node and Chrome.** The parent model
called `spawn_agent`; its child called the real dashboard `read_rows` tool; the
parent waited, then called `annotate_total`. Both runs changed application state
to 41, recorded the child's identity, and completed two separate histories. Each
used six model responses and four tool executions. In Chrome, both loops ran in
the Worker and the displayed total changed. Six outgoing browser prompt records
verified with the actual AIUI toolkit and inspector. The harness did not create
the child or compute the annotation on the model's behalf.

**Implication:** the portable runtime supports more than synthetic chat. It can
use host tools for a bounded coding task and coordinate independent agents inside
a browser application. Keep runtime ownership, host tools and client messages
separate when turning this into a production design.

045 recorded USD 0.009241485 estimated usage, including USD 0.001825750 for the
failed native setup attempt. With the separate compaction investigation, the
second round totals **USD 0.009664485 estimated**. Actual billing and research-agent
costs are unavailable. Raw evaluation data stays under `~/history/evals/`.

See the [runbook and full ledger](../../spikes/045-hp-behavior/README.md) and
[combined second-round findings](../../../docs/hp-agent-behavior.md). Complete
tool/protocol parity, general task quality, long-running browser behavior and
durable storage remain unqualified. No new production library was introduced.
