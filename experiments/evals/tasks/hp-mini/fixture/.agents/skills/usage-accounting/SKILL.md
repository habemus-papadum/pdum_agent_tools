---
name: usage-accounting
description: Rules for reconciling recorded model-request usage in this project.
---

# Usage accounting

`summarizeUsage(records)` returns `{sessions, totals}`. Each session row has
`sessionId`, `requests`, `inputTokens`, `cachedInputTokens`, `uncachedInputTokens`
and `outputTokens`. The totals object has the same numeric fields without an ID.
All counters are nonnegative integers; input records have valid fields.

- Exclude `origin: "copied-context"` before reconciling records. These are inherited
  history, not new requests, even when their revision is greater.
- A request is identified by the pair `(sessionId, requestId)`. Different sessions
  may legitimately use the same request ID. IDs are arbitrary strings, including
  punctuation; do not concatenate them with an ambiguous separator.
- For each identity, keep the record with the greatest integer `revision`.
  If revisions tie, the last record in the supplied array wins.
- Only the winning record contributes. Never add old and revised counters together.
- Cached tokens are a subset of input. `uncachedInputTokens` equals input minus
  cached input. Never add cached tokens to the input total again.
- Return sessions sorted by JavaScript's ordinary string comparison on `sessionId`.
  Do not mutate the array or any input object. Frozen inputs must work.
- Empty input returns an empty sessions array and a totals object with all five
  numeric fields equal to zero.

After implementing a change, add regression tests and run the actual Node test
command. Include the sentence "Cached tokens are a subset of input." in README.md
alongside a short explanation of request identity and inherited records.
