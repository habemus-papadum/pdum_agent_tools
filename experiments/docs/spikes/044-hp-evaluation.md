# 044: Comparable small coding tasks and corrected accounting

**Question.** Can we compare HP Agent with native Codex on a bounded real coding
task, without allowing history or pricing errors to distort the result?

**Result, 18 October 2026.** The `hp-mini` task and shared reporter are ready for
the matched live arms. Both agents receive byte-identical prompts and initial
projects, including an explicit local skill. They repair a usage summarizer, add
regression tests, run the actual Node tests and explain the change. Independent
checks outside the agent project validate the delivered function, scope and test
run. The seed fails eight gates; a reference repair passes all eleven.

Three accounting problems were corrected before comparison:

1. **The main conversation follows lineage.** An explicit root or sole lineage
   root is selected; a child cannot replace it merely by making more requests.
   Multiple roots require an explicit choice.
2. **Inherited tool output is counted once.** Both tool-call counts and byte sums
   exclude copied context. Forked history no longer inflates output-byte totals.
3. **Cost follows each response's actual model.** Luna's standard rates are
   corrected, mixed-model calls are priced separately, and subcent precision is
   retained. Missing usage or pricing produces an unknown total rather than zero.

New reports identify pricing revision `2026-10-18-standard-v2`. Existing baseline
files remain unchanged, and incompatible price versions skip the cost-envelope
comparison with a warning. Luna's dated standard rates are $0.10/$0.01/$0.125/$0.50
per million uncached input/cached input/cache-write/output tokens; long-context
multipliers are applied when relevant. These are estimates, not actual billing.
[Official Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

**Validation.** Seventeen tests passed against actual DuckDB files using the
unchanged agent-history v5 schema. They include child/root ties, inherited fork
data, mixed model prices, missing usage and independent task checks. Ruff checks
and formatting passed. This track made no paid requests. Live measurements belong
to [045](045-hp-behavior.md); readiness here is not a claim of agent quality.

**Fairness.** Match exact model, reasoning effort, service tier, task files and
checks; run arms sequentially. Codex still has native prompt framing and tool
implementations, while HP uses the experimental tools from 042. Record those
differences explicitly. A single small matched pair tests feasibility and the
evaluation pipeline, not general equivalence or superiority.

**Reproduce.** The [runbook](../../spikes/044-hp-evaluation/README.md) supplies
preparation and reporting commands. Scratch projects and raw run records go under
`~/history/evals/`; preparing them requires no credentials or Git branches.
