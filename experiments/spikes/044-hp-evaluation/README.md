# A small, fair comparison and trustworthy measurements

This spike prepares the `hp-mini` coding task and repairs the existing eval
reporter's root selection, inherited-tool accounting and price calculation.
It runs no paid requests. The coordinated live HP/native Codex comparison is
owned by [045](../045-hp-behavior/README.md).

## Prepare isolated arms

From the repository root:

```sh
uv run --frozen python experiments/spikes/044-hp-evaluation/prepare.py \
  --run-id 2026-10-18-hp-mini-hp-r1 --agent hp --model gpt-6-luna --effort low
uv run --frozen python experiments/spikes/044-hp-evaluation/prepare.py \
  --run-id 2026-10-18-hp-mini-codex-r1 --agent codex --model gpt-6-luna --effort low
```

Each command copies the same fixture into
`~/history/evals/RUN_ID/worktree`, writes the exact prompt, and creates `run.json`
with prompt/file hashes, model, reasoning effort and standard service tier.
It creates no Git branch, worktree metadata, profile, credential copy or model
request. `EVALS_HOME` can select another directory. Existing run directories are
never reused. The shared eval tooling calls this scratch directory a `worktree`;
it is an ordinary directory.

The execution harness must record the actual root thread ID in
`run.json.root_thread_id`, actual runtime/model/effort/tool settings, elapsed
seconds, exit code, and usage trace in the shared schema. Preserve run data in
that directory. No raw traces or answer patches belong in Git.

After execution:

```sh
uv run --frozen python experiments/evals/bin/report.py RUN_ID
```

The reporter invokes the independent checker from the repository; its assertions
are not copied into the agent's project. `--root-thread-id ID` overrides selection
for a single report invocation. No model is called by preparation or reporting.

## The task

[The exact prompt](../../evals/tasks/hp-mini/prompt.txt) asks the agent to repair
`summarizeUsage(records)` in a tiny dependency-free JavaScript project, add
regression tests, run them, and document the change. Both agents must read the
same explicit local [usage-accounting skill](../../evals/tasks/hp-mini/fixture/.agents/skills/usage-accounting/SKILL.md).

The bug is realistic: repeated usage records, thread-local request identities,
forked history, cached-token subsets and ordering can produce plausible but
wrong totals. The seed has one passing smoke test and several actual bugs.
The hidden-from-the-scratch-project checker verifies:

- Empty input and exact output shape.
- Cached input counted as a subset, not additional input.
- Highest revision wins; ties use the last source record.
- Inherited records are excluded before deduplication.
- Session-scoped identity works with separator characters in IDs.
- Input arrays/objects may be frozen and are not mutated.
- Session order uses ordinary JavaScript string comparison.
- Skill-required README explanation, allowed-file scope and at least four tests.

The objective checks directly import the delivered function. The agent's own
tests are an additional gate, never the sole proof. Fixture validation showed the
seed fails eight gates. A reference repair passes all eleven gates. The reference
exists only in the checker regression test and is not copied into task fixtures.

This is intended to fit roughly five to ten tool calls. That is an experiment
target, not an enforced productivity score. One run per agent establishes a
working comparison pipeline; it does not establish a reliable quality ranking.

## What must match, and what cannot yet match

Match exact task/prompt hashes, initial files, model `gpt-6-luna`, reasoning
`low`, service tier `default`, permissions, host Node executable, working
directory content and objective checks. Run arms sequentially to avoid measuring
machine contention. Do not coach either agent after the initial prompt.

HP's Node tools come from [042](../042-hp-tools-skills/README.md). Native Codex
uses its own tools. Record the differences: tool schemas/serialization, code-mode
versus conventional function calls, prompt placement, native environment and
skill discovery, parallel scheduling and installed context defaults. HP can use
the exact selected Codex base text without reproducing Codex's complete assembled
request. These are architecture differences being evaluated, not controlled
variables to claim away.

Read the skill at the same relative path in both projects. HP can advertise it
through the supplied skill catalog and/or the prompt's explicit path; actual
loading should be visible in the trace. The task does not require MCP, subagents,
browser execution or compaction. Those facilities have separate probes.

## Reporter corrections

The old reporter selected whichever thread made the most model requests. A child
could therefore become the displayed "main" session. It now uses an explicit
manifest root or the sole lineage root, considering both thread metadata and
spawn/fork edges. Ambiguous multiple roots require an explicit choice. Root
context/step metrics remain root-specific; tool totals and price estimates cover
all recorded new work in the run.

Tool-call counts and output-byte sums both exclude `copied-context` rows.
`node --test` is recognized in native command items and HP's generic tool-call
records. This recognition is a useful trace hint, not proof by itself that the
agent ran a meaningful test command; the actual command/result is reviewable.

Prices are applied per recorded response model, not once using the root's most
common model. Estimates retain nine decimal places so cheap runs do not round to
zero. Missing model prices or required usage fields produce an unknown total,
with an explicitly partial subtotal. No usage records means unknown cost, not
free execution. An explicit provider ledger value of zero is retained separately
and does not fall through to a nonzero estimate.

New reports use pricing revision `2026-10-18-standard-v2`. The dated Luna standard
rates per million tokens are $0.10 uncached input, $0.01 cached input, $0.125 cache
write and $0.50 output. Above 272,000 input tokens, the entire request uses twice
the input/cache rates and 1.5 times the output rate. These are standard list-price
equivalents, not actual subscription billing or service-tier/regional charges.
[Official Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

The same check also corrected Sol's copied Astra tuple to $2/$0.20/$2.50/$10.
Astra's table remains $10/$1/$12.50/$50. Claude rows retain their previously dated
2026-10-17 assumptions and are identified as such; this spike does not requalify
Claude pricing. [Official Sol pricing](https://developers.openai.com/api/docs/models/gpt-6-sol),
[OpenAI standard pricing](https://developers.openai.com/api/docs/pricing).

The original checked-in baselines are unchanged. When comparing new reports
with an unversioned/different pricing baseline, the reporter warns and skips the
cost envelope comparison. Recomputing historical baselines requires a deliberate
new baseline operation, never an implicit migration.

The estimator explicitly assumes an absent optional cache-write field means no
cache writes. Missing input, cached-input or output counts remain unknown.
One-hour cache writes are unpriced unless their rate is added. Recorded requests
must come from one coherent capture; arbitrary duplicate source merges are not
deduplicated by this narrow correction.

## Credential-free validation

From the repository root:

```sh
uv run --frozen pytest experiments/spikes/044-hp-evaluation/tests -q
uv run --frozen ruff check --no-force-exclude \
  experiments/evals/bin/report.py experiments/spikes/044-hp-evaluation
```

Seventeen tests pass using real temporary DuckDB files with the production v5
schema, not mocked SQL results. They cover root/child ties, more active children,
forks, explicit roots, inherited bytes, mixed model rates, long Luna requests,
missing price/usage, zero provider ledger, baseline preservation, independent
task gates and isolated preparation. Schema files and historical baselines were
not modified. This track's paid model usage is $0.
