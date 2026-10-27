# Storage-independent history and continuation

**25 October 2026; research implementation.** The archive, catalogue, completed
boundary selection and restore code depend on an asynchronous opaque-byte store.
They import no filesystem, IndexedDB, localStorage, browser UI or credential code.
The same serialized archive and TypeScript functions work with memory, filesystem
and IndexedDB adapters. These are prototype adapters, not a selection of the final
storage technology or a new production library.

## The boundary

`BlobStore` has four operations: list opaque keys, read bytes, replace a complete
value and remove a key. `ArchiveRepository` owns the shared versioned JSON codec
and catalogue projection. Reading/listing does not create a runtime or connector.
The filesystem adapter hashes the opaque key into a filename, writes a temporary
envelope and renames it into place. A key such as `../not/a/path/λ` is just an
identity, not a host path. IndexedDB stores the same encoded bytes in a transaction
and resolves writes after transaction completion. Browser globals appear only in
that adapter. Memory is useful for portable tests and is explicitly non-durable.

A returned write promises a complete replacement at the adapter's commit boundary.
It is not a promise of fsync, browser eviction resistance, cross-device replication
or survival of every OS/browser failure. Writes use one owner in this study. Concurrent
writers to the same key are not arbitrated: a future multiwriter contract needs
explicit conflict behavior. No lease or storage quota is introduced here.

`captureArchive()` has no I/O. The host explicitly decides when to persist and
await a commit. A failed write stays an error and leaves a previously committed
archive readable in the injected-failure case. It does not halt the runtime.
Continuous asynchronous archive recording/backlog management is a later integration;
this code does not insert a disk wait into provider forwarding or observation.

## What the archive retains

`HpArchive` version 1 contains stable source provenance, the most recent execution
owner ID, saved thread snapshots, full model context, opaque reasoning/compaction
items, context checkpoints, usage records, owner-scoped journals, observed jobs
and their sequenced output/progress. Each owner epoch retains its instruction,
model and tool-name recipe. Full history is retained; there is no image pruning.

Source identity persists across resumed owners and forks. Each usage retains
its producing owner and native response identity. Previously observed usage
stays in the archive; it is not inserted into a resumed runtime's new usage list.
Capture merges records by response ID and rejects conflicts in counters/model,
actor, turn, endpoint or producing owner. Compaction usage is supplied explicitly
by its caller, with a null turn attribution and an `afterTurnId` context boundary;
discarded compaction work can still count as real usage.

The archive does not serialize credential values, connector instances, callbacks,
running Promises, process handles or tool implementations. Host bindings supply
those again. Stored tool names allow a missing-binding warning. A dynamic
`beforeModel` callback is also host-supplied; the stored instruction recipe alone
does not recreate arbitrary application prompt-building logic.

## Restore and fork

`resumeArchive()` creates a fresh `AgentRuntime`, retains the selected conversation
ID and imports its saved context plus any parent chain needed for routing. It
does not automatically load every historical sibling/child as executing work.
The archive continues to contain those conversations. The new owner creates no
model request until the caller submits an explicit turn.

`forkArchive()` takes an exact `{runId, seq}` reference returned by
`completedBoundaries()`. Several snapshots can share an `afterTurnId`: one may
precede compaction and another may follow it. Both retain their exact context;
the fork does not reconstruct model input from rendered transcript text. Forking
creates a new conversation ID, preserves source lineage and marks inherited
turns as copied context. The new runtime imports only the fork, so saving it cannot
overwrite the source's newer history with an old cutoff snapshot.

Only recorded completed-turn boundaries are offered for this first historical
fork implementation. A saved `inProgress` turn remains visible as observed; direct
executable restore rejects it and asks for an explicit completed checkpoint.
Gracefully interrupted/failed turns have their recorded terminal state and repaired
tool context from the existing runtime. Queued/sent/included input records imported
as history become uncommitted evidence, with an explanation, instead of entering
the new owner's delivery queues. Jobs remain observed history and generate a
warning when they had been running; they are never automatically recreated.

This applies RC-04/07/08/09/12: conversation context is not an execution checkpoint,
unknown effects stay unknown, history reads are passive, and a fork does not replay
tool side effects or roll back files. The prototype's inherited native-shaped
`ephemeral` metadata is not a declaration of the new adapter's durability.

## Portable checks

`runPersistenceScenarios(store)` uses a labelled local provider simulator and a
real host tool. It checks full byte round-trip and catalogue reads, new-owner
resume, no tool replay, exact context before/after a synthetic compaction boundary,
fork source preservation even after saving the merged result, job/output retention,
incomplete-owner snapshots and explicit removal. These are mechanics checks, not
proof of a real model remembering context. Root integration separately qualifies
the same path with actual model responses and actual browser storage.

The scenario is run against memory and real filesystem adapters in
`src/persistence.test.ts`; it is exported unchanged for the browser IndexedDB
harness. Additional checks cover fresh filesystem adapter instances, opaque keys,
an injected commit failure, malformed JSON, unknown archive version and duplicate
conversation identities. The existing 039 runtime's 13 checks still pass after
the small `restoreSnapshots()` addition.

Remaining scope: large-history/paged reads, storage capacity/eviction behavior,
multiwriter conflict semantics, automatic persistence scheduling, persistent
job recovery, cross-tab execution hosting, arbitrary mid-turn recovery, and a
fully validated long-lived archive schema. The format is deliberately versioned
so incompatible data fails visibly rather than being treated as empty history.
