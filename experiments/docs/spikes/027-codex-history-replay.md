# 027 — History is a transcript, not an event recording

**Observed 2026-10-14:** paginated native history reconstructs this small real
text/command/file-patch conversation after restart without loading an agent or
requiring credentials. Legacy history loses a command item and rewrites some
item IDs. Even paginated history truncates persisted command output and does not
recreate the original stream or its usage notifications.

The primary corpus used **Codex 0.162.1**, macOS arm64, Node **26.10.0**, and two
explicit **gpt-6-luna** turns. Executable identities are recorded in
[026 details](026-admin-details.md). Exact invocation metadata, six raw usage
snapshots, native rollout copies and API snapshots live under private
`artifacts/027-codex-history-replay/run-1792000414999/`.

| Evidence | Paginated | Legacy |
| --- | --- | --- |
| User text, assistant text, file diff | Preserved with live IDs | Preserved; user/assistant IDs become `item-1`, `item-2` |
| Executed command, combined output, exit status | Preserved | Missing from structured read/turns history in this custom-tool execution case |
| Item paging | Works, both directions and exclusive item anchors | `-32601: thread/items/list is not supported yet` |
| Turn summary | User/final answer; command/file items omitted | Also an incomplete view; request `itemsView:"full"` |
| Usage and context window | Not in returned turns/items | Not in returned turns/items |
| Live output/delta timing | Requires recorded protocol | Requires recorded protocol |

Inspected minimal wire sequence for a live command versus its durable tail:

```json
{"method":"item/started","params":{"threadId":"T","turnId":"U","item":{"type":"commandExecution","id":"I"}}}
{"id":1,"method":"thread/items/list","params":{"threadId":"T","turnId":"U"}}
{"id":1,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}
{"method":"item/completed","params":{"threadId":"T","turnId":"U","item":{"type":"commandExecution","id":"I","status":"completed","aggregatedOutput":"TAIL_BEGINTAIL_END"}}}
```

Item payloads above show selected fields. The subsequent history read returns the
completed item with stored timestamps; history alone did not show the executing
command while it was running. Archived reads likewise worked after archive removed
the fork from the loaded registry.

A separate local-only output check captured **70,000 live bytes**, then read
**65,536 persisted bytes**, including the explicit native marker
`... command output truncated for persistence ...`. This is a native storage loss,
not truncation by our recorder. The latest local-only tail/cursor/archive evidence
is `artifacts/027-codex-history-replay/run-1792000866553/`.

Reproduce with [probe, local tail test and offline analyzer](../../spikes/027-codex-history-replay/README.md).
The offline analyzer runs without a server/auth/network and verifies final-item
replay is unchanged by duplicated captures. Reads on a fresh process left
`thread/loaded/list` empty before and after and emitted no turn/tool/usage events.
`thread/unsubscribe` alone did not unload these threads immediately; restart and
archive supplied the actual unloaded cases.

**Implication:** record from the beginning for faithful inspection of timing,
requests, usage and uncapped observed output. Native paginated history is a strong
transcript source with explicit missing-data semantics. Preserve `historyMode`,
`itemsView` and source provenance; do not interpret a summary or legacy omission
as “no tool ran.” [Detailed completeness matrix](027-history-details.md) includes
source anchors and untested item families. Observed corpus usage estimates to
**$0.00163042 API-equivalent** at the dated Luna rates; actual subscription billing
and upstream-only usage are unknown.
