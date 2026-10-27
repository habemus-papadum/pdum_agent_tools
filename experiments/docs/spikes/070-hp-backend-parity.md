# 070 — HP history survives its execution host

**25 October 2026.** HP now has a working research path for saved-history browsing,
fresh-owner resume, historical forks and accounting, with the **same storage-independent
TypeScript code in Node and a browser Worker**. Filesystem and IndexedDB are two
adapters over one asynchronous key/byte interface. Neither the archive format nor
the continuation logic assumes a disk path, localStorage or a particular browser
database. Memory and injected-failure adapters exercise the same boundary.

This closes the main HP feasibility gap identified by 069. It does not create a
production runtime package or select the orchestrator's final storage technology.

## What worked

| Journey | Observed result |
| --- | --- |
| Save, end the owner, inspect | A new Node process and a reloaded browser page could list/read saved conversations without invoking a model. Browser execution lived in a Worker; the original page/Worker heap was gone before continuation. |
| Resume compacted context | Real Luna resumed under the same conversation ID with a new execution owner and recalled both saved markers. The archive retained actual opaque compaction context, not a reconstructed prose transcript. |
| Fork earlier history | A fork at the first completed turn recalled the earlier marker and reported the later marker as unknown. It received a new ID, preserved lineage and left the source's latest history unchanged. |
| Avoid repeating effects | The original application tool ran once. Resume and fork performed zero calls to that tool. Reading/replaying history never submitted a prompt. |
| Change storage backend | Node-produced archive bytes round-tripped through actual IndexedDB; browser-produced bytes round-tripped through the filesystem adapter. Identities, context and statistics remained unchanged. |
| Share observation | Two actual MessagePort clients replayed one owner's notifications, detached and rejoined while execution continued. Recorded actions were not resubmitted. This used scripted model events in both Node and Chrome. |
| Ingest and count | Both real histories entered the existing Python writer and DuckDB schema. Portable calculations, production TypeScript pricing and SQL agreed. Re-importing an unchanged export added no work or cost. |

The main live scenario ran twice: a tool-producing parent turn, a later fact,
real compaction, a small child conversation, owner destruction, resume and an
earlier-point fork. Each environment produced six model responses and one compact
response. This is selected compatibility evidence, not a broad agent-quality test.

## The useful architectural boundary

Keep three concerns separate:

1. **Portable archive and history operations:** versioned data, catalogue,
   checkpoint selection, restore/fork and usage computations. Native response
   identity and stable source identity survive owner changes and storage moves.
2. **Storage adapter:** opaque keys and bytes, asynchronous read/list/replace/remove,
   with an explicit commit result. Filesystem replacement and IndexedDB transaction
   completion are different implementations of the same small interface.
3. **Execution host:** creates a fresh runtime and supplies credentials, tools,
   connections and application callbacks. These are not serialized JavaScript
   execution. Historical jobs and queued messages remain evidence, not restarted work.

Fork references identify an exact recorded checkpoint, including its owner and
sequence. A turn ID alone can be ambiguous because compaction may produce another
context at the same turn boundary. Instruction/model/tool-name recipes follow the
producing checkpoint; dynamic prompt-building callbacks remain host bindings.

Details: [persistence and storage](../../spikes/070-hp-backend-parity/persistence-notes.md),
[accounting and ingestion](../../spikes/070-hp-backend-parity/accounting-notes.md).

## Findings to address during production extraction

- **Compaction can be billed outside a turn.** Each real database passed eight
  selected invariants and exposed one failure in `responses-without-turn`.
  The existing schema already allows a null turn ID; the invariant needs to
  recognize legitimate out-of-turn operations. We did not invent a turn or hide
  that failure. Both the old exporter and current writer use schema version 5.
- **Pure pricing needs a separate module.** The production pricing file also
  imports Node filesystem code for refreshing its table. The spike injects a
  dated rate table into portable calculations and checks them against production
  functions/SQL. Extracting those pure functions will make direct browser reuse
  practical.
- **Incomplete execution is not a resumable Promise.** The archive preserves an
  unfinished turn, running-job observations and queued-input evidence. The first
  restore path requires a completed checkpoint for unfinished work and never
  redelivers saved pending messages automatically. Broader recovery policy remains
  a product decision.
- **Persistence scheduling remains separate.** Explicit saves commit whole archives.
  Continuous asynchronous recording, partial-history paging, multiple storage
  writers, eviction/power-loss durability and surviving browser-host destruction
  are not qualified here. A storage interface alone does not solve those lifetimes.

The next architecture can use this boundary now. A production `thread/resume`
adapter, HP source registration in the ingestor CLI, broader query checks and
host management still need implementation; these working helpers are not a claim
that those packages already exist.

## Validation and cost

Nine new Node tests passed, including 22 shared persistence checks on memory and
filesystem adapters, accounting coverage and MessagePort replay. The same 22
persistence checks and six attachment assertions passed in a real Chrome Worker
using IndexedDB. Thirteen existing HP runtime tests still passed. Browser builds,
typechecks, Python lint/format checks and the strict documentation build passed;
the actual database invariant gap above remains explicitly unresolved.

Versions: Node **26.10.0**, Chrome **155**, OpenAI SDK **7.38.0**, Python **3.14.7**,
DuckDB **1.5.6**, history schema **5**. The browser dev host supplied credentials;
the browser owned the runtime, tools, persistence and restore logic.

| Run | Observed model responses | Compactions | API-equivalent USD |
| --- | ---: | ---: | ---: |
| Node | 6 | 1 | 0.00116208 |
| Browser | 6 | 1 | 0.00036284 |
| **Total** | **12** | **2** | **0.00152492** |

All calls used `gpt-6-luna`; every observed response had accounted usage. Estimates
use the 17 October price snapshot, not actual subscription billing or assistant
implementation cost. No paid retries were needed. The dedicated probe host and
browser Worker were stopped; the existing mock service and ordinary profiles were
untouched. See the [runbook](../../spikes/070-hp-backend-parity/README.md) and
[usage ledger](../../spikes/070-hp-backend-parity/usage-ledger.md).
