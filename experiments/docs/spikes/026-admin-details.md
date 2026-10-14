# 026 detailed evidence

## Versions and isolation

All release runs used the resolved `/Users/nehal/.local/bin/codex` executable,
`codex-cli 0.162.1`, SHA-256
`74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`.
025 verified release tag source `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.
The targeted source run used clean commit
`6c372fbef45f730b6d8aa727b0ec8332365588db`, `codex-cli 0.0.0`, SHA-256
`e40aeb592b458d689cb4b4a5c8cb5f50ff4135c0a852af35822ba0684515a10c`.
Do not attribute source-build-only methods to the installed release.

The dependency-free Node harness uses direct native WebSockets, experimental API
opt-in, isolated HOME/CODEX_HOME/cwd, explicit model Luna, never approvals and full
access. Copies of existing credentials are used only for one vanilla CLI invocation
and removed afterward. Other live probes pass the access token through login RPC.
Normal credential files are never modified; the current runners hash-check them.
All captures/profile paths are private and ignored. The final source-build probe
copies experiment state and rebases absolute rollout/cwd paths before reading or
resuming it. An earlier development attempt copied without rebasing; its result is
superseded by `run-1792000798508`. Neither attempt touched normal operator sessions.

## Catalogue and identity

`thread/start` creates a loaded thread even before it has a catalogue-visible first
user message. Naming, attaching a note or running `thread/shellCommand` did not make
that otherwise empty session appear in this sample's list. A fork inherited history
and was addressable by ID but remained omitted until its own user work. Therefore
`thread/list` and `thread/loaded/list` answer different questions; their union is
still not a promise of every historical internal thread.

The release default lists interactive sources (`vscode` here); completed `exec`
was absent until explicitly included. An empty provider list included the observed
provider, a nonexistent provider returned none, and cwd filters matched the fixture.
Path strings alternated `/var/...` and canonical `/private/var/...` across responses;
thread ID, not textual cwd equality, is the primary identity.

Created-at paging with limit one returned a later renamed row under its new name;
there is no immutable snapshot guarantee from these results. After revert, scan-
and-repair listing yielded the same parent ID at two rollout locations with distinct
creation times. Native `thread/read` selected the current thread view. `thread/list`
also returned null `forkedFromId` for a fork whose `thread/read` reported its parent.
Both are observed discrepancies, not claims that native storage always corrupts
ancestry. Preserve raw rows, deduplicate for presentation and refresh detail.

The tested root's `sessionId` equalled `id`; forks received fresh values for both,
set `forkedFromId`, and retained null `parentThreadId`. Fork ancestry must not be
treated as spawned-child ancestry. Parent archive left the fork available. Deleting
the disposable fork left the source intact. Spawned descendants were not generated
in this track; the child-health track supplies separate evidence.

## Organization and search

`project/create` accepted absolute roots, idempotency key and arbitrary metadata;
thread project assignment survived restart. `threadSection/create` and
`threadSection/list` are the exact methods; moving uses `thread/section/move`.
Section, name, project, attachment, archive and deletion notifications reached
initialized client B in the tested server lifetime.

Attachments accept an application-owned type/key/JSON payload. Duplicate add returns
`outcome:"existing"` and the original payload, even if the submitted payload differs.
No update method was established: mutation should use the native remove/add contract
or distinct immutable keys after checking desired replacement behavior. No atomic
replacement guarantee was tested. A separate attachment per tag permits native
`attachmentOwner/list` queries; arbitrary JSON predicates were not established.
Owner lookup includes archived matches unless `archived:false` is requested.

`thread/metadata/update` supports specific native metadata; it is not an arbitrary
JSON bag. The source/type inventory has no tested `isPinned` field. App-specific
pin semantics can be an attachment or section; they should not masquerade as a
native pin synchronized with every official UI.

`thread/list.searchTerm` matched the visible name and original preview. A later
exchange absent from preview was not found by `thread/search` in the observed run.
`thread/searchOccurrences` on its known ID returned the later prompt and assistant
answer with item/turn IDs, snippet ranges and turn cursors. Global exhaustive search
needs further qualification; a zero result is not proof of absence.

## Source-build additions

Read state is returned beside the thread, with opaque `revision` and `firstUnread`.
An unloaded thread accepted `operation:{"type":"unread"}` with the seen revision,
returning `firstUnread:{"type":"threadStart"}`. Reusing the prior revision for read
failed with `-32600`, `data.reason:"readStateConflict"` and current state. A fresh
revision set `firstUnread:null`, persisted across restart and notified a resumed B.
The update itself left the loaded registry empty. A refresh followed by a fresh
user decision is appropriate after conflict; do not blindly retry a mark.

`thread/items/read` fetched known paginated item IDs, silently omitted an unknown ID
in a mixed request, rejected an empty array (`itemIds must contain 1 to 100 IDs`),
and rejected legacy history with `-32601`. These are source-build observations,
not release guarantees.

Source-inspected anchors, clean pin: [read-state eligibility, publication and
revision conflict](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_read_state.rs#L16),
[history/read-state projection](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L2932).
Eligibility excludes ephemeral/subagent/unknown and non-user-origin policy scopes;
those exclusions were inspected, not all independently executed here.
