# Context consumption: Codex Astra against Claude Code Fable

**Status: findings of 17 October 2026 from five weeks of Claude Code history, three
weeks of Codex history and one controlled three-arm run.** The question was whether
GPT-6 Astra at extra-high effort "burns" context faster than Fable 5.1 at extra-high
effort, and whether a large context costs money or time. The runs that produced the
baselines, and the way to repeat them with another agent, are in
`experiments/evals/` ([runbook](https://github.com/habemus-papadum/pdum_agent_tools/tree/main/experiments/evals)).

## The short answer

The perception is right about the share of the window and wrong about the rate. Per
step, the two agents add context at similar rates and Fable adds more. The difference
is the window: Codex gives Astra 258,400 tokens and compacts around 200k, Claude Code
gives Fable 1,000,000 and compacts around 500k. The same first turn fills a third of the
Codex window and a fifth of the Claude one.

## What the history says

All numbers are medians over turns with at least two model responses, Astra and Fable at
extra-high effort only, from the agent-history files on one machine.

| Measure | Codex, Astra | Claude Code, Fable |
| --- | ---: | ---: |
| Context added per model step | 2.5k | 3.6k |
| Model steps per turn | 13 | 6 |
| Context at the end of a thread's first turn | 109k | 197k |
| Same, as a share of the window (p50 / p75) | 42% / 54% | 20% / 29% |
| Window consumed per minute of a first turn | 3.0% | 1.1% |
| Compactions per 100 turns | 26 | 6 |
| Output tokens per step | 0.6k | 1.7k |

In the five repositories both agents work in, growth per step is within noise while
Codex takes about twice the steps per turn and Fable writes about three times the
output per step. Fable reaches 100k of context in under two minutes of a thread's life
and Codex in about eight, because Fable starts at a larger baseline and writes more.

**Latency.** Response time grows with context on both, more on Astra. For outputs of 200
to 2,000 tokens the median response takes 11.6 s under 50k of context and 22 s above 200k
on Astra, 6.3 s and 8.6 s on Fable. Streaming speed is flat on both, about 26 tokens per
second for Astra and 80 for Fable, so the slowdown is time to respond, not generation.
Context explains almost none of the variance in latency (r² of 0.05 and 0.003): output
length does.

**Cost.** Astra's cached-read price is four times Fable's, so re-reading context is where
Codex spend goes. Between 150k and 200k of context, 85% of a Codex step's list cost is
input; cache reads are 61% of all Codex spend here against 22% on Claude, where output
dominates. Per step, list cost rises from $0.10 under 50k to $0.25 at 150k to 200k on
Astra, and from $0.18 to $0.34 on Fable. Per thousand output tokens Codex costs about
twice as much; per turn the two are close.

**Quality.** The only proxies the history offers, failed commands and interrupted turns by
peak context, are flat on both agents. That is not evidence either way.

## Where the Codex window comes from

Codex fetches a model catalog from OpenAI's backend and caches it in
`~/.codex/models_cache.json`. For Astra it says `context_window` 272,000,
`max_context_window` 872,000 and `effective_context_window_percent` 95; Codex reports
272,000 × 0.95 = 258,400 in every `token_count` event and derives auto-compaction from it.
Nothing in a user's `config.toml` sets this. Setting `model_context_window` there
overrides the catalog value, clamped to `max_context_window`, in both the installed
0.162.1 and current `main` (`codex-rs/models-manager/src/model_info.rs`). The
`supports_experimental_context` flag is a separate, currently unavailable
context-management feature, not a window knob.

## The controlled run

One task, one prompt, one non-interactive turn per arm, run one after another in clean
launcher profiles and fresh worktrees: write a typed TypeScript client for the Claude
launcher's management API (ten routes plus a WebSocket helper, tests against a mocked
fetch, workspace conventions, all gates passing).

| Measure | A: Codex, default window | B: Codex, 872k window | C: Claude Code, Fable |
| --- | ---: | ---: | ---: |
| Wall time | 9.1 min | 7.0 min | 14.3 min |
| Model steps | 22 | 22 | 25 |
| Tool calls | 39 | 34 | 59 |
| Peak context | 92k | 92k | 185k |
| Share of window at peak | 35.6% | 11.2% | 18.5% |
| Context added per step | 3.4k | 3.4k | 6.9k |
| Output tokens (thinking) | 19k (2.7k) | 21k (3.6k) | 72k (36k) |
| Tool output bytes | 217k | 230k | 257k |
| List cost | $3.81 | $3.31 | $7.77 |
| Rubric (of 18) | 15 | 15 | 16 |

All three delivered a package that passes install, lint, typecheck, tests and build,
covers every route, and matches the Python handlers' field names. The Claude package
typed error and usage bodies precisely and reproduced Python's URL quoting; it also made
two unrequested edits outside the package. The two Codex runs are near copies of each
other, which doubles as a measure of run-to-run noise: two minutes and fifty cents under
identical conditions.

Arms A and B show that the window setting changes only the denominator. Arm C shows
where Fable's faster per-step growth comes from: its own output, 72k tokens against 20k,
half of it thinking that stays in context during a tool-use turn. Tool output volumes were
similar. The slowdown question stayed untested: no run passed 200k.

## Caveats

One run per arm. Both agents ran without the user's plugins and MCP servers, so baselines
start lower than daily sessions. Claude's cost is its own ledger, which prices cache
writes at the one-hour tier; Codex's is a list-price estimate from the rollout. Neither is
a bill: both agents ran on subscription plans.

## Open item

A context-pressure run: the same task started after pre-loading each agent to about 150k
of context, where Codex spends most of its time and where neither agent went here. That
is the experiment that would test "slower and worse at high context" directly.
