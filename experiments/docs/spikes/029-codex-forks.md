# 029 — Branching duplicates history, not the environment

**Observed 2026-10-14:** full and boundary forks preserve conversation prefixes,
settings and inherited usage. Parent/fork continuations separate correctly. Active
work becomes an interrupted historical tail in the fork; it is not rerun. Revert
removes conversation history without undoing a real filesystem side effect.

Version: installed **Codex 0.162.1**, macOS arm64, Node **26.10.0**, explicit
**gpt-6-luna**. [Executable identities](026-admin-details.md) and
[inheritance details](029-fork-details.md) accompany the private capture
`artifacts/029-codex-forks/run-1792000579846/`.

| Operation | Observed behavior |
| --- | --- |
| Full / through-turn fork | Copies completed prefix; new thread/session ID, `forkedFromId` source, null spawned `parentThreadId`. |
| Before-turn fork | Excludes selected turn and later history. Combining before/last IDs is rejected. |
| Ephemeral paginated fork | Requires `excludeTurns:true`; path is null. Combining ephemeral with defer-goal is rejected. |
| Warm resume overrides | Requested read-only/on-request overrides were ignored; effective response stayed full-access/never. Cold resume restored saved settings. |
| Active local command fork | Parent command finished once; fork tail marked interrupted. No duplicate command or file write was observed. |
| Manual compaction | contextCompaction start/completion and completed turn; previous visible transcript retained. Last context estimate changed, cumulative usage did not. |
| Queue insertion | **`thread/queue/add` on idle loaded thread immediately started a new turn.** No `queue/start` was sent. |
| Active goal cold resume | **Resume started an automatic turn.** Probe paused and interrupted it immediately. |
| Deferred goal fork | Active goal copied; no turn observed for 750 ms, then explicitly paused. |

Representative inspected sequence, selected fields:

```json
{"id":1,"method":"thread/queue/add","params":{"threadId":"F","clientUserMessageId":"queue-research-1","input":[{"type":"text","text":"Reply QUEUED_ONLY.","text_elements":[]}]}}
{"id":1,"result":{"queuedSubmission":{"id":"Q","clientUserMessageId":"queue-research-1","input":[{"type":"text","text":"Reply QUEUED_ONLY.","text_elements":[]}]}}}
{"method":"turn/started","params":{"threadId":"F","turn":{"id":"U","status":"inProgress"}}}
{"id":2,"method":"thread/queue/list","params":{"threadId":"F"}}
{"id":2,"result":{"data":[],"nextCursor":null}}
```

The example shortens the prompt and turn payload; the raw sequence is retained.
The extra queue turn completed with eight output tokens and is included in the
ledger. An important negative: paginated ephemeral fork without `excludeTurns`
returns `-32600`, `ephemeral paginated thread/fork requires excludeTurns: true`.

Reproduce with [the bounded runner](../../spikes/029-codex-forks/README.md), using a
027 corpus. It includes two explicit replies, one queue submission, one compaction,
a goal token budget of 64 and an external 240-second process bound. No provider
model substitution occurred. Three completed reply responses had approximately
**$0.00063094** newly observed API-equivalent usage; manual compaction and the
immediately interrupted goal have incomplete billing coverage. Actual subscription
billing is unknown.

**Implication:** expose browse/read separately from resume/fork/queue/goal actions.
Loading can create work. Track inherited accounting separately from new branch
usage, and expose returned effective settings. Fork/revert is not a filesystem
snapshot, process restart or Hostfork clone. Pending-question inheritance, spawned
child policies and queued work surviving a crash require separate cases; this run
does not claim them qualified.
