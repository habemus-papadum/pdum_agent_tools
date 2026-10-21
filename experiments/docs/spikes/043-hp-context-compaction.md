# 043 — Explicit compaction and opaque context forks

**Result, 18 October 2026:** the official Responses API supports explicit
compaction with `gpt-6-luna`. The TypeScript prototype preserved the complete
transcript, continued from the compacted context, and forked that context onto a
fresh WebSocket connection. It also reused a native opaque reasoning item on a
separate connection before compaction.

The live task read an inventory manifest from a local fixture tool. Its delivered
quantity required solving three modular constraints; the smallest solution was
500. After subtracting 19 returned and 23 packed units, available inventory was
458. This made a tool result and a derived value important to subsequent turns.

| Check | Observed result |
| --- | --- |
| Reasoning at `low` effort | The constraint task produced a completed opaque reasoning item and 131 reasoning tokens. A prior simple arithmetic run produced none: the setting does not guarantee an item. |
| Fork before compaction | A new connection received the complete native context, including the unchanged opaque item, and correctly reported 458 available. |
| Explicit compaction | The API returned a retained user message plus an encrypted compaction item. Both became the next context unchanged. |
| Context size | API counts for the supplied context with the same instructions and no tool definitions fell from **344 to 205 tokens**. This is one small example, not a general compression ratio. |
| Continue after compaction | Packing five additional units correctly changed availability to 453. |
| Fork after compaction | Another fresh connection received the compacted context plus later items; adding 11 delivered units correctly produced 464. The parent remained unchanged. |
| Historical inspection | The original transcript and tool result stayed intact; offline replay reconstructed the same snapshots and context checkpoint. |

The [adapter](../../spikes/043-hp-context-compaction/src/compaction.ts) takes an
already-authenticated client. It compacts an idle thread and checks that the
thread has not changed before applying the response. If another turn starts
while compaction is in flight, the result is discarded without overwriting that
turn; its usage is still returned. Local HTTP/runtime tests exercise that race,
provider failure, and transcript/checkpoint preservation. A browser build contains
no Node imports; the live qualification itself ran under Node.

Two practical details matter. First, encrypted reasoning and compaction items
are provider artifacts, not readable thoughts or summaries. Preserve the entire
returned window, including retained messages, as the
[official compaction guide](https://developers.openai.com/api/docs/guides/compaction)
requires. Second, token counting needs the full relevant request shape: excluding
the structured-output schema undercounted ordinary requests by 28 tokens. A
count-only follow-up including it matched the observed input usage exactly.
Serialized bytes and opaque payload length are not token meters.

The complete investigation used **seven ordinary responses and one compaction**:
2,275 input and 391 output tokens, including 166 reasoning tokens already included
in output. The dated API-equivalent estimate is **USD 0.000423**; actual billing
is unknown. Compaction alone accounted for 362 input and 96 output tokens,
estimated at USD 0.0000842. The
[detailed ledger](../../spikes/043-hp-context-compaction/details.md) includes the
initial run that stopped because no reasoning item appeared.

Versions: `openai` 7.38.0, Node 26.10.0, pnpm 11.9.0, macOS arm64; existing 038
connector and 039 runtime reused unchanged. The compact endpoint has no caller
output-token limit in this SDK, so the probe used one short input and a documented
planning allowance rather than pretending its ordinary response cap applied.

See the [runbook](../../spikes/043-hp-context-compaction/README.md) for reproduction.
This qualifies the mechanics and one small retention task. It does not establish
lossless long-session compaction, cross-model reuse, credential refresh, durable
recovery, or arbitrary historical-turn forks.
