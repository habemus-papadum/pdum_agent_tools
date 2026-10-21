# 040 — HP Agent in Node and a real browser

**Observed 18 October 2026:** the same client workflow completed against live Luna
in Node and Chrome 155. In Chrome a Worker owned the runtime; a development relay
only attached credentials and forwarded model WebSocket messages. The experiment
demonstrates a portable agent, not merely a browser UI controlling a Node agent.

Each flow called a host tool once, accepted and committed a steering update,
spawned and messaged an independent child, continued a fork without changing its
parent, replaced model context with an explicit checkpoint, and replayed the
saved transcript offline. Each yielded three threads, five visible turns,
fourteen items and five model responses. Child operations were selected by the
test harness, not by the model.

All ten client model requests across the two runs used the full imported native
Luna prompt through actual `aiui-prompts` records. Captured sends verified equal
to their semantic reconstruction. The browser used the actual prompt inspector's
headless controller with plain HTML presentation; it showed prompt text, source
provenance and equality to the captured request.

Actual exported history rows were accepted by the existing v5 schema and measured
by the existing eval function. Each contained five real response-usage records,
one fork and one spawn edge. The browser journal's 62 native notifications passed
the generated schemas. Native Codex itself also passed an isolated start/local
command/read/list/fork check with no credentials or inference.

**Recommendation:** continue with a small TypeScript runtime over the official
OpenAI Responses transport, separate host adapters, and selected native Codex
messages. Keep the full native client surface available for Codex. Share prompt
inspection and history computations without forcing Claude into that protocol.

**Limits:** no coding-quality comparison, durable recovery, model-selected
delegation qualification, full Codex tools/skills/MCP, real compaction, or
reasoning-heavy forks. The checkpoint test proves separation of transcript and
model context. It does not prove compression quality. The existing evaluator's
Luna prices, inherited-byte summation and root-thread selection need corrections
before comparing future full evals; the spike leaves its baseline data unchanged.

Node and browser estimates were USD 0.000641985 and USD 0.000224225. With 038,
the entire round recorded sixteen generated responses for **USD 0.00106551
estimated API usage**, actual billing unknown. A diagnosed browser relay framing
failure returned no response usage. Delegated research-agent billing is unavailable
and is not included in this figure.

See the [combined overview](../../../docs/hp-agent-findings.md) and the
[runnable integration and ledger](../../spikes/040-hp-integration/README.md) for
commands, precise versions, evidence locations and known gaps. Raw evidence is
ignored; evaluation measurement copies live under `~/history/evals/`.
