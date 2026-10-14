# 026 — Native session administration and marks

**Observed 2026-10-14:** native projects, sections and arbitrary attachments are
useful organization primitives. A separate tag database is unnecessary for the
tested single-profile use case. Catalogue rows still require reconciliation: they
are not authoritative complete thread objects.

Installed **Codex 0.162.1**, macOS arm64, Node **26.10.0**; explicit binary identity
and source-build identity are in [details](026-admin-details.md). The clean pinned
source build adds usable read/unread markers that the installed release lacks.

| Capability | Observed result |
| --- | --- |
| Name, project, section, archive/unarchive, delete | Accepted; survive process restart where applicable; B receives native change notifications. Archive unloads the selected thread. |
| Tags/notes/application owner | Arbitrary JSON `thread/attachment/add` payload survives restart. `attachmentOwner/list` finds all threads for a type/key, including archived by default. Duplicate identity is idempotent, not a payload update. |
| Pin field / arbitrary metadata | `tags`, `note`, `isPinned` alone in `thread/metadata/update` are rejected as an empty update. No native pin was established; an application attachment or section can encode one. |
| Catalogue visibility | Empty threads and forks with no own user message were omitted even when loaded. Default listing omitted a completed vanilla `codex exec` session; `sourceKinds:["exec"]` found it. |
| Pagination and ancestry | After revert, scanning lists yielded one thread ID twice with different rollout paths/timestamps. List rows lost fork ancestry that `thread/read` returned. Deduplicate by profile/thread ID, then refresh selected detail. |
| Search | Name/preview search worked. Global search missed a later `PARENT_ONLY` exchange; per-thread `searchOccurrences` found both prompt and answer. |
| Clean source build | `thread/readState/update` persisted read/unread; stale revisions conflicted. Marking did not load the thread. Subscribed B received `thread/readState/changed`. |

Representative inspected wire sequence, identifiers shortened:

```json
{"id":1,"method":"thread/attachment/add","params":{"threadId":"T","attachmentType":"spike.tag","identityKey":"research","payload":{"label":"research"}}}
{"id":1,"result":{"outcome":"created","attachment":{"id":"A","attachmentType":"spike.tag","identityKey":"research","payload":{"label":"research"},"createdAt":1792000690}}}
{"method":"thread/attachment/updated","params":{"threadId":"T"}}
{"id":2,"method":"thread/attachmentOwner/list","params":{"attachmentType":"spike.tag","identityKey":"research"}}
{"id":2,"result":{"data":[{"threadId":"T","archived":false}],"nextCursor":null}}
```

The notification example shows its identifying field; full notification payloads
remain in the private capture. Important negative: local nonempty `originators`
filter returns `-32602`, not a silently filtered list.

Reproduce with the [runnable probes](../../spikes/026-codex-session-admin/README.md).
Authoritative local runs: `026/run-1792000438877` (administration),
`026/run-1792000516433` (one vanilla CLI turn), `026/run-1792000689765`
(catalogue/reconciliation), `026/run-1792000798508` (rebased source-build clone),
under `artifacts/026-codex-session-admin/` with the `026/` shorthand removed.
The first and last cases use no inference. CLI usage and the shared corpus are
accounted separately; actual subscription billing is unknown.

**Implication:** retain profile identity outside the protocol; store native thread
ID plus observed session/fork/parent identities and versioned provenance. Use
native attachments for operator tags/notes and native read state when supported.
An optional application index needs reconciliation and capability detection, not
a second source of truth. Spawned-child inheritance and cross-profile search remain
outside this probe; [details](026-admin-details.md) distinguish source evidence.
