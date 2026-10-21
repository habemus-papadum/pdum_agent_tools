# HP Agent: tools, compaction and a first coding comparison

The later [power-user parity pass](hp-agent-parity.md) adds a source-linked feature
matrix, mailbox/control refactoring and edge-case qualification. This page
preserves the second round's results.

**Completed 18 October 2026.** The second round establishes useful behavior beyond
the [first round's transport and client prototype](hp-agent-findings.md). HP can
repair a small project using its own host tools and a local skill, preserve model
context through real compaction and forks, and let a parent model delegate work
to an independent child inside a browser application.

I recommend moving on to the client/runtime implementation design. The core
choice remains the official Responses client with a small loop we own. We have
enough evidence for the basic boundaries; further evaluation should accompany
implementation rather than another broad feasibility survey. This does not yet
justify promising complete Codex behavior or general coding quality.

## Results together

Details live under `experiments/docs/spikes/`; repository links become available
after commit/push. Raw evaluation data is local under `~/history/evals/`.

| Investigation | What we learned | Detail |
| --- | --- | --- |
| Host tools, skills and MCP | HP's own subprocess and patch tools perform real work. Eleven selected patch cases matched native Codex's outcomes and file bytes. Explicit skill loading and actual local MCP round trips work. | [042](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/042-hp-tools-skills.md) |
| Compaction and reasoning context | Luna accepted explicit compaction. Fresh connections reused both encrypted reasoning and compacted state, while the original transcript remained readable. | [043](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/043-hp-context-compaction.md) |
| Evaluation reliability | Root selection, inherited output accounting and per-response pricing were corrected. Missing usage/prices remain unknown. Historical baselines were preserved. | [044](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/044-hp-evaluation.md) |
| Coding and browser application work | HP and native Codex passed the same eleven coding checks. Model-selected child execution updated a real dashboard total in Node and Chrome. | [045](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/045-hp-behavior.md) |

## The coding comparison

Both agents received identical prompts and a tiny dependency-free JavaScript
project. They had to read a local accounting skill, repair a usage summarizer,
add regression tests, run those tests and document the result. The bugs included
double-counting cached tokens, confusing request identities across sessions,
choosing the wrong record revision, including inherited history and mutating the
caller's input. An independent checker outside the scratch project evaluated
the delivered implementation.

| Result | HP | Native Codex |
| --- | ---: | ---: |
| Independent gates passed | 11/11 | 11/11 |
| Regression tests added and run | 5 | 6 |
| Wall time | 25.68 seconds | 23.35 seconds |
| Recorded model responses | 10 | 4 |
| Tool calls | 9 | 11 |
| Estimated API usage | $0.002965455 | $0.003178000 |

Both used `gpt-6-luna`, low reasoning and default service. They ran sequentially
in separate scratch directories, with no operator edits during execution. Both
changed only the permitted source, tests and README. Their traces show that they
actually ran the tests; success was not inferred from their final claims.

This is one small case. Native tool grouping, prompt framing and cache behavior
differ from HP's. Fewer model round trips did not imply fewer tool calls, and the
small cost/time differences do not establish a winner. The useful conclusion is
that HP can already complete a bounded coding task through the evaluation path.

There was a meaningful prerequisite failure. Our clean source-built Codex lacked
its separate code-mode host executable. It reported that limitation and performed
no edits; its CLI still exited zero, which illustrates why independent checks
matter. Building the helper failed because an upstream V8 archive was unavailable.
The successful baseline therefore used the complete installed **Codex 0.163.0**
distribution, with executable hashes recorded. HP still uses the pinned prompt
reference `6c372fb...`. The failed run is preserved and included in the spend
ledger, not counted as evidence of inferior native coding quality.

## A browser use case with real delegation

The browser example is a small inventory dashboard. The user asks the parent to
delegate a calculation. The parent model calls `spawn_agent`; its child reads the
application's rows through `read_rows` and returns their total. The parent waits,
then calls `annotate_total` to update the page to **41 units**.

The model chose the tool calls and child message. The harness verified that the
child really read the data, that the parent really waited, and that the displayed
annotation carried the child's identity. It did not create the child or fill in
the answer on the agent's behalf. Both loops ran inside the Chrome Worker; the
host relayed model traffic and supplied credentials. Node completed the same
application task. Each used two threads, six model responses and four tools.

All six browser model requests passed through `aiui-prompts`, and the actual
inspector verified their saved prompt records. The separate histories also
exported to the existing agent-history schema. This is a concrete example of the
browser-local use case: application tools can be useful without a filesystem or
shell. It remains a small synchronous task, not proof of reliable background-tab
or multi-hour execution.

## What compaction now means in the design

Real Luna compaction returned a retained user message and an encrypted context
record. We preserved that entire returned window unchanged, as the API requires.
It was used to continue the parent and to start a fork on a fresh connection.
The task's expected quantities remained correct: 458 before compaction, 453
after a correction, and 464 on the later fork. The parent's state stayed unchanged
when the fork continued. The counted context fell from **344 to 205 tokens** for
that small example with the same instructions and no tool definitions.

These encrypted records are reusable model state, not human-readable summaries.
The user-facing transcript and original tool results must remain separate. Low
reasoning effort also does not guarantee a reasoning item: the first simple task
produced none, while a harder task did. Both outcomes are recorded.

The context-counting probe exposed another practical detail: its structured-output
schema contributed 28 input tokens. A meter that counted only the visible messages
would have missed them. The eventual context view should distinguish measured
full-request usage, explicit token counts and estimates; serialized bytes are not
a token count. Compaction usage is recorded separately in this spike and must join
the production session ledger without inventing a user conversation turn.

## Tool fidelity and remaining differences

HP's Node tools do not require the native Codex executable. Native Codex was used
only as a comparison oracle. Twenty real tests cover subprocess input/output,
failed commands, patches, skills and local HTTP MCP. Eleven native patch
comparisons matched success/failure and resulting file bytes. Native pipe command
checks matched exit/output and stdin behavior.

Review found and fixed two important errors: a TERM-ignoring descendant could
survive after its leader exited, and a failed file move could conceal an already
written destination. Regression tests now verify owned-group cleanup and truthful
partial-change reporting. The native evaluation harness received similar cleanup
tests for failures after launching a process.

The tools are still a selected implementation. PTYs and explicit stdin EOF control
are absent; `max_output_tokens` is advisory and output is retained in full; some
native patch/newline behavior remains outside the corpus. Skills load from explicit
roots with provenance, rather than reproducing every native discovery rule.
MCP initialization, schemas, calls, errors and cancellation were tested against a
real local server. Browser bundling works, but remote OAuth and delivering MCP
images as model image input remain unqualified.

## What to implement next

I would preserve four responsibilities as we refine the implementation plan:

1. **The Codex client:** complete native protocol access, shared request/event
   routing, WebSocket and MessagePort transports, and explicit history/live APIs.
   HP supports selected native messages and named extensions. Claude retains its
   official client and its own semantics.
2. **The HP runtime:** turns, steering, tools, context transitions and independent
   child lifecycles, with caller-supplied model connections. It should remain
   usable without a UI, local filesystem or credential implementation.
3. **Host integrations:** Node processes/files, browser application tools, skills,
   MCP and existing credential factories. These should not become mandatory
   dependencies of every browser agent.
4. **Recorded evidence and analysis:** prompt operations, original provider items,
   transcripts, lineage and usage, feeding the existing history contract. Reuse
   its TypeScript analysis in production; the corrected legacy Python eval script
   remains a research harness, not a second proposed analysis library.

The first production milestone should retain the demonstrated flow and its tests,
then add storage and a small session/context view. The longer coding battery,
additional tasks, child failure/cancellation under load and browser suspension
tests can proceed alongside that work. We should measure these before claiming
durable recovery or native-quality parity. No production library was created in
this round; the [client design](specs/codex-client.md) remains the baseline to refine.

## Spend and validation

| Investigation | Estimated API-equivalent USD |
| --- | ---: |
| Real compaction/reasoning investigation, including its first attempt | 0.000423000 |
| HP coding task | 0.002965455 |
| Successful native coding task | 0.003178000 |
| Native missing-helper attempt | 0.001825750 |
| Node model-selected delegation | 0.000852245 |
| Chrome model-selected delegation | 0.000420035 |
| **Second-round total** | **0.009664485** |

The estimate uses reported Luna usage and prices dated 18 October 2026, including
cache reads/writes. Reasoning is already included in output usage and is not added
again. Actual billing, count-only endpoint charges and coordinating/research-agent
costs are unavailable. [Published Luna rates](https://developers.openai.com/api/docs/models/gpt-6-luna).
The first round's separately reported estimate was $0.001065510.

Validation includes real native tool comparisons, local subprocess/network tests,
provider compaction and continuation, a matched pair of independently checked
coding results, real Chrome execution, history-schema exports and documentation
checks. Detailed versions, commands, failures and evidence paths are in the linked
spikes. Raw captures, profiles and projects remain outside Git. No commit, push
or release was performed.
