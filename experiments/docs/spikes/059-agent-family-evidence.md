# 059 — Agent families and meaningful duration

**24 October 2026 · evidence collected, ready for the next mock.** We can build a
useful family view from native history, with explicit gaps. Codex supplied one
parent and all five referenced children, including item-level clocks. Claude's
official helpers supplied complete listings of two selected copied families,
but many original parent calls and relationship identifiers are absent from the
returned conversation chains.

Duration is useful when its scope is named. The evidence supports **reported tool
elapsed time**, **recorded start-to-end intervals**, and **observed waits** as
separate quantities. A background task's lifetime and a child's recurring work
are different again. None is automatically CPU time or a reason to flag work as
stuck. This extends the [behavior inventory](059-evidence-inventory.md).

## What we collected

| Native collection | Returned history | What is established |
| --- | --- | --- |
| Codex everyday family | 1 parent + 5 children; 5,785 items across 104 turns | All recursively referenced children found; 61 item-history pages match full-read identities and item payloads; no unresolved references in this selected family. |
| Claude nested family | 4 visible main messages + 25 children containing 2,929 messages | Every SDK-listed child was read; six explicit nested-parent links, five joinable parent calls and one joinable result. Ten children lack a usable parent tool ID. |
| Claude contrasting family | 559 main messages + 4 children containing 305 messages | Every listed child was read, but all four SDK parent identities are unavailable. Four Agent calls independently survive in the main transcript. |

“Complete” is deliberately bounded: all discovered/referenced members of these
selected snapshots were read. It does not mean every historically launched agent
still exists on disk, every pre-compaction message survives, or any process is
currently running. No original profile was passed to a conversation runtime.
The existing 23-session viewer catalogue and its documents were left unchanged;
these new family exports are private evidence for the next presentation slice.

### Parent/child interpretation

The Codex parent's 53 child-completion activity records map to 53 captured child
turns, spread across its five children. A child can complete work, receive more
input and complete again. **A completion activity is not process termination.**
The mapping uses the observed completion-item ID convention and inspected source;
that convention is versioned evidence, not a newly promised stable SDK contract.

Native activity records retain a target and activity kind, while the returned
typed interaction items do not retain the sent message body. All 18 older
collaboration tool records in this family are waits with null prompts. Child
responses and tools are available, but an activity arrow cannot confidently show
the exact originating message or delivery acknowledgement. The history projection
also omits separate inter-agent communication records; richer mail inspection
needs a separately qualified source or API.

There is no native item-ID or turn-ID overlap among these six Codex histories.
All 104 `rootTurnId` values are absent, despite other parent/child evidence.
Missing root IDs must not erase the relationships we actually have.

Claude's SDK child identity is **root session ID plus agent ID**. Child documents
retain both instead of inventing standalone child sessions. A null parent-agent
field can mean main-agent parent or unavailable metadata. The collector labels
relationships as `sdk-parent-agent`, `matched-native-parent-tool`, or
`main-or-unknown`; it does not turn uncertainty into a definite root edge.

All matching Claude metadata sidecars existed, including those whose parent IDs
were not usable through the SDK. In the nested family, 20 launch calls and 24
results cannot be joined from the returned chains. Compaction/selected-chain
coverage matters; a missing parent call does not establish that no launch occurred.
The nested family also repeats 11 native message UUIDs and six assistant response
IDs across documents. Family-wide usage must account for that reuse before
summing, and per-agent attribution needs ownership evidence. These numbers are
not unique provider-request totals or a billing calculation.

## What duration means here

| Display meaning | Evidence and scope | What it must not imply |
| --- | --- | --- |
| **Reported tool elapsed** | Native `durationMs` on a command, MCP call or other supported operation. Retain the provider/type and units. | CPU time, exclusive active execution, or identical semantics for every tool. |
| **Recorded interval** | Difference between the same item's producer start/completion clocks, when both exist. | A reported execution measurement. A point event can have equal endpoints without representing a zero-duration task. |
| **Observed wait/span** | Time between notifications seen by one client on one monotonic clock. | Provider execution time; it includes observation/transport effects and may miss either endpoint. |
| **Background lifetime** | An explicitly linked task/process start and terminal outcome, if supplied. | The time until its launching tool returns, or until the parent finishes a turn. |
| **Child work episode** | An explicitly identified child turn/work completion and its own clocks. | Lifetime of the reusable child or a reason to remove it from discovery. |
| **Turn elapsed** | Native turn start, completion and reported duration. | Sum of tool durations: tools/children can overlap, and turns can include waits. |
| **Open-ended history** | Start or progress was observed; terminal evidence is absent. | Zero duration, success, or a task that is still running today. Use the capture/observation boundary, not the current clock. |

For the selected Codex family, all 5,785 paginated item entries carry
`startedAtMs` and `completedAtMs`. Those wrappers need to survive API adaptation;
extracting only `entry.item` discards useful clocks. Turn clocks remain Unix
**seconds**, while item clocks and durations use **milliseconds**. There are 104
turn starts and 103 turn ends/durations; the missing end remains unknown.

| Item kind | Explicit `durationMs` records | Endpoint interval minus reported duration |
| --- | ---: | --- |
| Command execution | 2,159 | −29 to +11 ms; 586 values differ |
| MCP call | 447 | 0 to +4 ms; 265 values differ |
| Intentional sleep | 4 | +2 to +3 ms; all four differ |

No endpoint interval was negative. These small differences are evidence of
separate measurements, not an invariant to “fix” by overwriting one with the
other. Some native commands report zero; missing values remain distinct. All 56
user-message items and seven image-view items have equal endpoints but no
reported duration. The UI should not give them a “0 ms execution” badge.
Intentional sleep should be described as waiting, not automatically as a slow tool.

Source inspection explains further boundaries. Codex unified execution can
return while a PTY remains alive; a later exit watcher emits command completion
against the original turn, even after another turn begins. Its reported elapsed
value can include output draining/finalization. Dynamic-tool duration includes
waiting for the external response or cancellation. Neither is a universal measure
of work performed inside the tool.

The two Claude families contain 17 and 14 explicit background Bash requests.
Their public history helpers return neither wrapper timestamps nor structured
execution-duration fields. The collectors' measured read latency is only reader
latency. The existing ingestion path can derive a call/result interval from raw
storage timestamps, but that is a different source and still does not establish
a background process lifetime. No new private transcript parser was introduced.

### Previously recorded timing examples

An additional read-only audit reused the 032 and 057 client captures. It found
one command completion arriving **28.711 ms after** its parent-turn completion;
two started commands have no completion in their respective captures. Five paired
032 command events retain reported durations separately from client receipt spans
—for example, 2,883 ms reported versus 2,885.621 ms observed. Missing endpoints
remain null. No old session was restarted to obtain these examples.

## Implications for the next UI slice

1. Add a family selector and explicit child activity using this Codex family.
   Unknown/missing relationship or message content should stay inspectable; a
   child-completion marker must not imply that the child was shut down.
2. Join item-history clocks by native thread/turn/item identity. Compare sequence
   and calendar-time navigation; retain the true elapsed span in collapsed gaps.
   Avoid hiding child/job activity merely because the parent's turn ended.
3. Add compact duration badges only to operations with a meaningful qualified
   measurement. Let inspection show its source and basis. Use neutral ongoing/wait
   presentation for long-running work; “slow” or “stuck” needs separate expectations.
4. Keep family usage/cost/context tracks tied to source coverage and response
   identity. Claude duplicate IDs, missing clocks and incomplete parent links are
   useful test cases, not reasons to fill in values.

The 30-minute gap example, lane widths/density, default tracks and rendering
backend remain provisional. No automatic timeout, unhealthy-duration threshold,
recovery policy or production schema was chosen. No viewer UI was changed in
this collection step.

## Reproduction and validation

Run Python collectors/tests from the **repository root** using its uv environment.
Both collectors require a new output directory and keep original native payloads.
They copy only selected history/metadata into temporary isolated homes, never
credentials/configuration, and close their owned readers.

```sh
uv run --frozen python experiments/spikes/058-native-history-access/collect_codex_family.py \
  --source-home /path/to/codex-home --parent-id NATIVE_PARENT_ID \
  --binary /path/to/codex \
  --output experiments/artifacts/058-native-history-access/families/codex-new

uv run --frozen python experiments/spikes/058-native-history-access/collect_claude_family.py \
  --root /path/to/.claude --session-file /path/to/.claude/projects/project/session.jsonl \
  --output experiments/artifacts/058-native-history-access/families/claude-new
```

Actual private runs:
`families/codex-20261024T155028Z`, `families/claude-20261024-d2` (nested) and
`families/claude-20261024-c2` (contrast), under the existing ignored 058 artifacts.
The bounded Claude selection examined six candidates; older attempts were
retained. The selected two were reread after clarifying uncertain parent labels.
Each export includes documents, relationship/timing analysis, source hashes,
version and reader cleanup evidence. Ordinary source history hashes remained
unchanged; Codex loaded registries were empty before/after; Claude helpers made
zero network/provider calls; temporary homes and helpers were cleaned up.

```sh
PDUM_CODEX_FAMILY_EXPORT_DIR=experiments/artifacts/058-native-history-access/families/codex-20261024T155028Z \
  uv run --frozen python -m unittest discover -s experiments/spikes/058-native-history-access \
  -p test_codex_family.py -v
PDUM_CLAUDE_FAMILY_RUN=experiments/artifacts/058-native-history-access/families/claude-20261024-d2 \
  uv run --frozen pytest -q experiments/spikes/058-native-history-access/test_claude_family.py
```

Repeat the Claude check with `claude-20261024-c2`. **Five Codex checks and five
Claude checks for each selected family passed**, including real page/full-read
comparison, source hygiene, relationship ambiguity and timing coverage. Ruff
lint/format checks passed. From `experiments/`, the separate recorded-event audit
has two passing clock-scope regression checks:

```sh
node --test spikes/059-historical-viewer/audit-recorded-timing.test.mjs
node spikes/059-historical-viewer/audit-recorded-timing.mjs \
  artifacts/059-evidence-inventory/recorded-timing.json \
  artifacts/032-codex-health/1792000511740/clients.jsonl \
  artifacts/057-launcher-inactive-turns/1792423898790/clients.jsonl
```

Versions: Codex **0.164.0**, Claude SDK **0.2.165**, Python **3.14.7**, macOS.
Source-only duration interpretation uses the Codex checkout
`6c372fbef45f730b6d8aa727b0ec8332365588db`, especially
`core/src/unified_exec/{process_manager,async_watcher}.rs`,
`core/src/tools/handlers/dynamic.rs`, `core/src/agent/control/completion.rs`, and
`app-server-protocol/src/protocol/{thread_history,thread_history_projection}.rs`.
The installed Claude SDK's public session/subagent helpers own chain selection;
its live `TaskUpdatedMessage`, `TaskNotificationMessage` and `ResultMessage`
provide additional timing/lifecycle surfaces to qualify later.

This slice applies RC-01/04/05/08/09 and records the consequential timing guidance
as [RC-10](../../../docs/runtime-contracts.md#rc-10-duration-and-completion-have-a-scope).
New experiment inference: **USD 0**. Original historical usage and assistant
implementation/research execution are separate from this amount.
