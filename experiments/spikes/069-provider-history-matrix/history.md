# History, replay and continuation

These are different operations, even when they produce a similar transcript.
Status labels and version boundaries are in the [evidence register](README.md).

**070 update:** the HP columns below describe the 039–052 baseline. The subsequent
[storage/continuation spike](../../docs/spikes/070-hp-backend-parity.md) adds actual
filesystem/IndexedDB catalogues, fresh-owner resume and exact historical-checkpoint
forks, with real Node and browser evidence. It also passes actual HP archives through
the existing schema-v5 writer and pricing queries. The shared RPC still lacks a
production `thread/resume` adapter and the production ingestion CLI does not yet
register HP sources. Schema v5 is still current; no schema migration was needed.

| Source or operation | Codex | Claude | HP Node | HP browser |
| --- | --- | --- | --- | --- |
| List saved conversations | **Observed:** native catalogue, with omissions and duplicate rows requiring scoped reconciliation. [026][c-admin], [058][native] | **Observed:** official history helpers scoped to profile/workspace. Different from listing running workers. [016][claude], [058][native] | **Observed/Source:** list threads in the current runtime. No durable on-disk catalogue service. [039][hp-runtime], [protocol][hp-protocol] | Same current-runtime list. No browser-persistent catalogue adapter. |
| Read without starting model work | **Observed:** `thread/read`, full turn/items and pagination; loaded registry stays empty. Legacy item methods can reject. [027][c-history], [058][native] | **Observed:** official list/info/messages without model credentials or worker. [058][native] | **Observed:** runtime read and pure offline journal reconstruction. [040][hp-live] | **Observed:** same in Worker and offline reconstruction in browser study. [040][hp-live] |
| What a native read includes | **Observed:** selected completed conversation/tool items; incomplete running tools may not appear. History mode and full/summary selection matter. [027][c-history] | **Observed/Source:** selected visible parent chain, not every record in the transcript file. Compaction can exclude earlier messages. [058][native] | **Source:** full current saved thread snapshots; context stored separately. No Codex paging implementation. [runtime][hp-source] | Same data model; storage/transfer remains supplied by host. |
| Reconstruct an observed live stream | **Observed:** optional captures can replay observations, not rerun commands. Native history alone cannot reproduce all deltas/usage. [027][c-history], [034][observation] | **Observed 068:** entire native stdout replayed to attached clients; stdin/stdout/stderr separately journaled. No fabricated input echo; clients observe Claude's own output. [068][raw-claude] | **Observed:** `replay(journal)` selects saved snapshots without a connector; notification entries also retained. Not a complete upstream network archive. [039][hp-runtime], [runtime][hp-source] | Same pure replay, exercised in live-browser integration. No IndexedDB/OPFS durability qualification. [040][hp-live] |
| Analytical ingestion | **Observed:** local rollouts/native databases provide facts omitted by RPC projections. Existing Python ingestor feeds shared DuckDB schema. [035][analysis], [061][ingestion] | **Observed:** existing Python ingestor reads copied native logs, including usage. It is distinct from official helper projection. [061][ingestion] | **Observed:** prototype exports rows accepted by the then-v5 history writer. **Gap:** production ingestor config currently accepts only `codex`/`claude`; no HP source adapter. [040][hp-live], [config][ingest-config] | Same prototype export shape; production browser-to-ingestor delivery/storage is unqualified. |
| Resume saved context | **Observed:** `thread/resume` rejoins a loaded thread or reconstructs a runtime under the same thread ID. May activate a saved goal. [056][inactive], [064][continuation] | **Observed:** new worker with existing session ID; prior context recalled. Current evidence uses official SDK workers; raw-native resumed launch remains unqualified in 068. [064][continuation] | **Gap:** current experimental RPC has no `thread/resume`; pure replay returns data, not a new executable runtime. [protocol][hp-protocol], [runtime][hp-source] | Same gap. Retaining a journal in browser storage would not implement runtime restore. |
| Fork latest or at a point | **Observed:** new thread ID; full, before-turn and inclusive turn-boundary cases. Selected 064 UI uses inclusive `lastTurnId`. [029][fork], [064][continuation] | **Observed:** official helper forks through selected assistant-message UUID; source preserved, new session ID. [064][continuation] | **Observed:** fork an idle current thread, copying transcript and model context. Arbitrary historical-turn cutoff not implemented. [040][hp-live], [043][compaction] | **Observed:** same idle fork in real browser. Live compaction-context fork was Node-only. [040][hp-live], [043][compaction] |
| Fork while work runs | **Observed:** native active-command fork records interrupted tail; no repeated side effect in selected case. [029][fork] | **Unqualified:** 064 used ended source histories. | **Gap:** runtime explicitly rejects active-thread forks. [runtime][hp-source] | Same explicit rejection. |
| Clone files, processes or callbacks | **Gap by operation:** conversation fork/revert does not restore environment or undo tool writes. [029][fork] | **Gap by operation:** history fork/resume is not process/callback recovery. [016][claude] | **Gap by operation:** fork does not duplicate running jobs or execution. [052][jobs] | Same; cannot clone a running Promise/Worker from transcript data. |
| Compaction and transcript | **Observed:** native explicit compaction preserves visible transcript in selected case; model context changes. [029][fork] | **Observed:** helper may expose only post-compaction selected chain; no promise of complete pre-compaction viewing through this API. [058][native] | **Observed:** explicit provider compaction preserves transcript, stores returned context/checkpoint, allows later continuation/fork. [043][compaction] | **Source/build:** portable adapter bundles without Node imports; live compaction was not run in browser. [043][compaction] |

## Identities are part of the interface

A useful history reference carries provider, host/source, profile, native
conversation identity and working-directory scope. Runtime identity and connection
identity belong beside it, not in place of it. A new worker can continue an old
conversation; a fork creates a new conversation without creating a new filesystem.

Codex items have thread/turn/item identity. Paginated and legacy history do not
necessarily return the same item IDs; 027 observed legacy rewriting. Claude's
saved wrapper UUID, assistant response ID and tool-use ID are different keys.
Claude child history is identified by root session plus agent ID, whereas Codex
child threads have their own thread IDs. HP currently distinguishes a thread ID
from a shared family/session ID. [027][c-history], [059 families][family],
[067][live-history], [runtime source][hp-source].

The production schema already includes `source_id`. A copied conversation can
exist in several sources, so joins and deduplication must preserve that scope.
061 found older query paths that joined only on thread ID and therefore could
multiply usage or select another copy's model. Its study refuses that unsupported
multi-source preset case; it did not repair the entire production query pack.
[061][ingestion].

## What the API should not infer

- A successful read is not a subscription, a running agent or an instruction to
  continue. A successful resume is not necessarily passive.
- Replaying received records reconstructs client state. It does not resend old
  inputs, re-execute tools or automatically respond to old server requests.
- An accepted fork does not prove every media asset is still available or all
  pending-question/context combinations are valid.
- Native history availability does not depend on optional development capture.
  The new Claude per-process journal has a different purpose: attach/reconnect
  while that process exists.
- HP's original pure replay does not restore execution. 070 supplies an explicit
  fresh-owner import path with host bindings and qualifies schema-v5 export;
  pending tools/jobs are still not restored. Keep those paths distinct when
  extracting the production interface.

These distinctions apply RC-03/05/07/08/09/12/13. Cross-profile/host continuation,
unsupported cut points and restore-after-owner-loss remain later qualification
items; they are not prerequisites for ordinary read-only history views.

[c-admin]: ../../docs/spikes/026-codex-session-admin.md
[c-history]: ../../docs/spikes/027-codex-history-replay.md
[fork]: ../../docs/spikes/029-codex-forks.md
[analysis]: ../../docs/spikes/035-codex-analysis.md
[observation]: ../../docs/spikes/034-codex-observation.md
[native]: ../../docs/spikes/058-native-history-access.md
[family]: ../../docs/spikes/059-agent-family-evidence.md
[ingestion]: ../../docs/spikes/061-ingestion-statistics.md
[continuation]: ../../docs/spikes/064-history-continuation.md
[inactive]: ../../docs/spikes/056-codex-inactive-lifecycle.md
[live-history]: ../../docs/spikes/067-live-session-workspace.md
[claude]: ../../docs/spikes/016-claude-client-sessions.md
[raw-claude]: ../../docs/spikes/068-claude-feed-replay.md
[hp-runtime]: ../../docs/spikes/039-hp-agent-runtime.md
[hp-live]: ../../docs/spikes/040-hp-integration.md
[compaction]: ../../docs/spikes/043-hp-context-compaction.md
[jobs]: ../../docs/spikes/052-hp-work-integration.md
[hp-source]: ../039-hp-agent-runtime/src/runtime.ts
[hp-protocol]: ../039-hp-agent-runtime/src/protocol.ts
[ingest-config]: ../../../packages/agent-history/src/pdum/agent_history/config.py
