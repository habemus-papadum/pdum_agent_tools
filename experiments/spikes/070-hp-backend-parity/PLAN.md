# 070 — HP persistence, continuation and accounting

**Authorized 25 October 2026; disposable working spike.** Prove the journey:
run work → save → close the owner → inspect history → resume or fork → continue
→ compare statistics, in Node and a real browser.

The user explicitly requires the storage architecture to be independent of disk,
localStorage or other browser stores. A portable asynchronous key/byte interface
will separate the archive codec and runtime restoration from filesystem and
IndexedDB adapters. The adapter choices demonstrate substitution; neither is a
requirement for the future application. Credentials, live transports, functions
and process handles remain host bindings, not serialized execution.

## Scope and question timing

| Class | Treatment |
| --- | --- |
| Answered | Same TypeScript runtime/restore semantics in Node/browser; storage behind an adapter; separate history inspection and execution; explicit resume/fork; no automatic repetition of tools; reuse existing history schema and statistics. |
| Delegated | Small versioned archive shape, opaque key/byte storage operations, filesystem/IndexedDB proof adapters, focused network/storage tests. |
| Explore | Exact historical checkpoint/context boundary, retained job and input observations after owner loss, multi-client replay attachment, duplicate usage across resume/forks/exports. |
| Deferred | Production storage engine, multi-writer storage conflict policy, seamless in-flight recovery, cross-tab execution host, browser-host survival after page loss, large-history optimization. |

No unresolved product policy blocks this experiment. The first restore path uses
completed checkpoints. Incomplete work remains inspectable and cannot silently
become rerun work or a recovered job. The report will distinguish this provisional
boundary from a production recovery policy.

## Ownership

- Persistence agent: archive/codec/storage adapters, minimal HP runtime import
  seam, historical forks and local persistence scenarios.
- Accounting agent: portable measurement projection and adapter into the existing
  history writer/TypeScript queries, deduplication and real DuckDB checks.
- Coordinator: manifests/lock, replay attachment, browser and paid integration,
  combined report, shared plans and runtime contracts. No other lane submits
  paid calls or restarts the shared mock host.

## Acceptance and evidence

- **RC-07/08:** connection detach leaves the owner running; replay-to-live ordering
  is explicit. Storage failure does not masquerade as a successful save.
- **RC-09/10:** live, archive and ingested usage agree by source/response identity;
  missing counters stay missing. Fork-inherited context and repeated exports are
  not new billed work; subagent and compaction work have explicit attribution.
- **RC-12:** list/read starts no runtime; resume preserves conversation identity
  with a new execution owner; historical fork uses the requested completed
  boundary, preserves source and retains the correct context through compaction.
- Same portable archive and calculations work with real filesystem and browser
  IndexedDB adapters, including page reload and transfer of stored bytes between
  adapters. No filesystem or browser imports in portable code.
- Interrupted/tool-active capture retains uncertainty and historical evidence;
  restoration never repeats the prior tool or claims to recover a Promise/job.

Use isolated ignored artifacts and browser contexts. Local deterministic tests
exercise state/failure boundaries; a few bounded real `gpt-6-luna` requests
qualify restored context. Aim below USD 0.10, with an investigation ceiling of
USD 1 for important validation; no silent model substitution or automatic model
retries. Keep actual requests, failures, usage coverage and dated estimates in a
ledger distinct from subscription billing and implementation-assistant cost.
Existing launchers, ordinary profiles and shared preview service remain unchanged.
