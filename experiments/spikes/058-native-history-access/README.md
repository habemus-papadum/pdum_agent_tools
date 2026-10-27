# 058 — Native history access

The next evidence collection is documented in [agent families and meaningful
duration](../../docs/spikes/059-agent-family-evidence.md). New standalone
`collect_codex_family.py` and `collect_claude_family.py` read copied parent/child
families into separate ignored run directories. Codex collection retains paginated
item clocks; Claude uses official subagent helpers and records missing relationship
metadata. These collectors do not append to the existing viewer catalogue.

Question: can the historical viewer read real Codex and Claude conversations,
including tool results, without activating a runtime or reconstructing private
Claude storage? **Yes for this selected local corpus.** The report is
[058-native-history-access.md](../../docs/spikes/058-native-history-access.md).

This disposable export is a mock transport envelope, not an ingestion schema,
profile configuration format, production SDK or unified host coordinator.
The production ingestor continues to own `history.yaml` and agent-history tables.

## Scope and decisions

- RC-01/02/05: history is inspected through read methods. Codex must have an empty
  loaded registry before and after; no start, resume, fork or send is allowed.
- RC-07: native errors and missing fields stay in the export. A legacy item's
  absence cannot establish that no tool ran. Catalogue file counts are not a
  claim of discoverable session counts.
- RC-08: Claude uses the existing production `History` class and its official
  SDK helper process. There is no conversation worker or second query.
- Already answered: use native history; no DuckDB for historical browsing.
- Delegated engineering choices: temporary credential-free snapshots, JSON
  export and a small Node reader for the mock host.
- Explore in 059: layout, native block rendering, raw payload inspection and
  missing-usage presentation. Its fixture coverage remains separate.
- Deferred until continuation/live control: resume/fork semantics, explicit
  attachment, policy for retries and process lifetime. This slice needs none.

## Owner mappings

| Operation | Existing owner used |
| --- | --- |
| Claude catalogue/detail/messages | `packages/claude-launcher/src/pdum/claude_launcher/storage.py`: `History.list/info/read` |
| Claude native helpers | `_storage_helper.py`: official `list_sessions`, `get_session_info`, `get_session_messages` |
| Claude profile/environment | `Profile` and `History._start` → `build_environment(authenticate=False)`; only `claude/projects` copied into a temporary profile |
| Codex catalogue/detail/items | Native stdio app-server `thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/items/read` |
| Codex snapshot | Existing 035 technique: copy rollouts, back up native `thread_history_1.sqlite`, let Codex rebuild its catalogue |

The optional `--extra-claude-config` is a one-shot selection of a historical
research directory using the old spike layout. It copies its existing `projects`
tree unmodified into the production Profile layout. It does not parse messages,
rename encoded workspace directories or define an alternative profile schema.

## Reproduce

Run this exporter from the **repository root** with the root uv environment because
it imports the production Claude launcher. It creates a new ignored output
directory and refuses to overwrite one. No dependency or lockfile changed.

```sh
uv run --frozen python experiments/spikes/058-native-history-access/export_history.py \
  --codex-source /var/folders/vw/tdwty7n902d81s2lj6nz2y9w0000gn/T/pdum-history-n8ZjdS/home/.codex \
  --claude-profile artifacts/claude-launcher-validation/browser-api-2026-10-13/api-a \
  --claude-workspace artifacts/claude-launcher-validation/browser-api-2026-10-13/workspace \
  --extra-claude-config experiments/artifacts/014-claude-app-server/run-9TAxoR/launch/virtual-node/profile/config \
  --extra-claude-workspace experiments/artifacts/014-claude-app-server/run-9TAxoR/launch/virtual-node/profile/work \
  --output experiments/artifacts/058-native-history-access-new \
  --binary /Users/nehal/.local/bin/codex
```

Those are actual isolated corpora available on this machine on 19 October 2026.
The temporary Codex source was recorded by 027 and later reused by 026/029;
it is not the developer's normal home. A fresh machine needs an existing isolated
corpus passed through the same flags; this command deliberately does not create
new paid sessions or silently use normal profiles. Native source history stays
in place; all copied profiles and owned processes are removed when the export ends.

Run the meaningful captured-native checks from the root:

```sh
PDUM_HISTORY_EXPORT_DIR=experiments/artifacts/058-native-history-access \
  uv run --frozen python -m unittest discover \
  -s experiments/spikes/058-native-history-access -p 'test_*.py' -v
uv run --frozen ruff check --no-force-exclude experiments/spikes/058-native-history-access
uv run --frozen ruff format --check --no-force-exclude experiments/spikes/058-native-history-access
```

From `experiments/`, the dependency-free Node transport checks are:

```sh
node --test spikes/058-native-history-access/read-adapter.test.mjs
```

The Python native checks skip explicitly without `PDUM_HISTORY_EXPORT_DIR`.
The Node tests use **labelled synthetic** records only for unknown-field
preservation, identity mismatch and path/key checks. They do not claim upstream
compatibility. No provider-success response was fabricated.

## Transport into the mock

`read-adapter.mjs` exports `readCatalog(directory)` and
`readDocument(directory, key)`; unknown keys return `null`. It reads only a
catalogue-listed document and checks its provider/session identity. The coordinator
owns the GET-only `/__history/catalog` and `/__history/document/<key>` routes.
Default local data: `experiments/artifacts/058-native-history-access`;
the host can explicitly set `PDUM_HISTORY_EXPORT_DIR`.

```text
catalog.json: {version:1,sessions:[{version,key,provider,sessionId,title,source}]}
documents/<key>.json: same metadata plus {payload}
```

`source` holds native method, capture time, provider version, original profile,
host scope, read-only intent and coverage. All native payloads stay intact:

- Codex: `{thread, readResponse, turnPages, itemPages, itemReads}`. `thread` is the
  actual `thread/read` result; other entries retain the native RPC response/error
  envelopes. `itemReads` retain their requested turn and item IDs.
- Claude: `{info, messages}`, exactly the shape of the existing management detail
  response, preserving the official Python SDK's snake_case fields.

No image/file URLs are fetched, no source workspace file is opened for a tool
item, and local paths are not treated as available image bytes. `assets` is unused
in this corpus. Unknown fields and blocks remain available for raw inspection.

## Private evidence

The default ignored output contains the final 16 documents, metadata-only
catalogue, native `codex-protocol.jsonl`, `codex-stderr.log` and `evidence.json`.
The initial 15-document export is retained under the ignored sibling
`058-native-history-access-initial`; its Claude corpus lacked tools, so a prior
014 live tool session was added for the final result. Both attempts ran no inference.
Do not commit or publish these raw files.

The evidence records original transcript hashes before/after, unchanged native
catalogues, empty Codex loaded registries, the protocol read-method inventory,
non-execution notifications, versions and helper/process cleanup. Hash checks
cover transcript JSONL contents; they do not assert every temporary native
SQLite bookkeeping file is byte-identical. The source projection is opened
read-only by SQLite's backup API and interpreted only by the native app-server.

New experiment inference: **0 submitted turns, 0 provider tokens, USD 0 estimated**.
This does not mean old historical sessions were free. Their original paid probes
have separate ledgers; assistant implementation effort and subscription billing
are outside this exporter’s accounting.

## Everyday-history extension, 24 October 2026

The operator requested substantial examples after reviewing the small probe
corpus. The current local catalogue has **23 entries: the original 16 plus seven
everyday histories**. These are actual native reads of copied existing history,
not fabricated long transcripts. Five Codex documents have 144–3,948 items;
two Claude SDK documents have 434 and 652 visible messages. The original small
corpus and its evidence remain in place.

`extend_corpus.py` appends explicitly selected histories to an existing export.
Its private selection file has this shape; store real values under ignored
artifacts, never in a committed example:

```json
{
  "codexHome": "/selected/native/codex-home",
  "claudeConfig": "/selected/native/claude-config",
  "sessions": [
    {"provider": "codex", "file": "/selected/native/codex-home/sessions/.../rollout.jsonl", "cwd": "/existing/workspace", "sessionId": "native-id"},
    {"provider": "claude", "file": "/selected/native/claude-config/projects/original-encoded-directory/native-id.jsonl", "cwd": "/existing/workspace", "sessionId": "native-id"}
  ]
}
```

Run from the repository root against an export that does not already contain
those IDs:

```sh
uv run --frozen python experiments/spikes/058-native-history-access/extend_corpus.py \
  --selection experiments/artifacts/058-native-history-access/long-corpus/selection-final.json \
  --output experiments/artifacts/058-native-history-access-copy \
  --binary /Users/nehal/.local/bin/codex
```

The script refuses to overwrite existing documents. It copies only selected
rollouts and the native Codex projection, or selected Claude files with their
original project-directory names. It hashes originals before/after, starts
credential-free isolated readers, checks Codex's empty loaded registry, and
closes its owned processes. Native payloads remain unchanged. No model calls,
login, resume, fork or archive operations occur. Source selection scans are
discovery aids; only native API output supplies rendered messages.

The additive metadata is `source.corpus = "everyday"` and
`source.summary = {items, turns, bytes, features, featureCounts, phases,
metricFieldCounts}`. `bytes` measures compactly serialized native payload bytes,
not a transport limit or a claim about HTTP compression. `math-markers` only
identifies delimiter-like content, including source code and tool output; it
does not establish mathematical prose. A separately qualified 144-item example
has `math-in-prose` and three explicit `mathProseItemIndexes`, verified against
actual native assistant responses after excluding code and imported tool wrappers.
The seven documents total approximately **57.6 MB** on disk; the browser currently
downloads a whole document. Collapsing the UI does not reduce that transfer.

Selected native `localImage`/`imageView` references can be copied into `assets/`.
`source.assets` maps `{reference, path, kind: "copied-at-export", sha256, bytes,
capturedAt, qualification}`. Missing files have `kind: "unavailable"` and a
reason. The local copy is evidence of the file **at export time**; equality to
the image at conversation time is unverified. Native payload references are
not rewritten. The host may serve only these exported asset paths; it must not
treat arbitrary source paths as a file-serving API. Embedded native image bytes
stay embedded in this slice. These local copies do not implement S3 retrieval.

### Consequential findings

- Codex 0.164.0 preserves `agentMessage.phase`: `commentary` and `final_answer`.
  The viewer can use this evidence rather than guess from message position.
- Real Mermaid survives in assistant messages. The initial broad math marker
  scan selected source/tool content rather than useful conversational equations;
  UI review caught this. A supplemental native read now supplies two final
  responses with display/inline TeX and a commentary formula. This is a concrete
  reason to verify representative content rather than trust marker counts. Images
  include human uploads and tool-returned screenshots. A tool-returned image
  is not proof of image generation. MCP images use `{type, mimeType, data}`;
  Claude images use `{type, source: {type: "base64", media_type, data}}`.
- The Claude SDK returns its selected main parent chain. Its implementation
  intentionally does not follow `logicalParentUuid` across compaction; the
  compact summary replaces earlier messages. A 5,767-message source file
  returned four visible messages. File length is not SDK history length.
  We tried additional candidates and selected the 434/652-message examples;
  no private chain-reconstruction workaround was added.
- Claude messages carry usage/cache fields; the sampled Codex item histories
  still do not provide complete request usage or context occupancy. Cost and
  context remain separate unresolved derivations, not zeroes.

The private `long-corpus/qualified-run/evidence.json` records the final reads,
hashes, timings and returned field summaries. `long-corpus/claude-probes.json`
records the candidate/helper coverage investigation. The additional
`long-corpus/math-conversation-qualified-run/` retains its native read, exact
prose positions and source hygiene evidence. Future append runs create
their own timestamped evidence directories. Seven captured-native Python checks
and two Node reader checks passed. New inference remains **USD 0**.
