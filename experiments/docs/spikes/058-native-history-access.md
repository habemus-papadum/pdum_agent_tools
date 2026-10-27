# 058 — Native history without activating work

**Observed 19 October 2026:** the disposable exporter read **16 real historical
sessions: 7 Codex and 9 Claude**, with command/file results, a compaction record,
fork ancestry, Claude thinking and paired Claude tool calls/results. It submitted
no turns, performed no login or credential lookup, and left original transcript
contents unchanged. These are native API exports from copied isolated experiment
history, not reconstructed transcripts or a new ingestion schema.

| Surface | Measured result | Limit |
| --- | --- | --- |
| Codex `thread/list/read` | 7 native catalogue entries; all readable, with 20 turns in total | 13 copied rollout files do not imply 13 discoverable distinct sessions; catalogue omission remains explicit |
| Codex `thread/turns/list`, full items | Native turn/item identity agrees with full reads | Summary view is not used as the complete tool transcript |
| Codex `thread/items/list/read` | All six paginated sessions returned native items; paging content exactly matched full reads | The legacy session returned `-32601` for both item methods; errors retained |
| Codex lifecycle | `thread/loaded/list` empty before/after; catalogue IDs unchanged; no turn/item/usage notifications | Runtime status describes only this isolated reader, not every process that may know a source |
| Claude production `History` | Official SDK list/info/messages returned 9 real sessions, including 2 paired tool calls/results | No conversation worker or live result envelope; helper coverage differs from native live events |
| Claude source/profile hygiene | Original and copied project transcript hashes unchanged; list unchanged; helpers closed | No claim of recovery, authentication or live worker behavior |

The export consumes the existing Claude launcher’s
[`History`](../../../packages/claude-launcher/src/pdum/claude_launcher/storage.py),
whose helper calls official `list_sessions`, `get_session_info` and
`get_session_messages` with `authenticate=False`. It retains the management
response shape `{info,messages}` and native snake_case fields. The older 014
tool corpus is copied unmodified into a temporary production `Profile`; no
private Claude transcript parser or workspace-path reconstruction was added.

Codex receives only copied `sessions`/`archived_sessions` and a SQLite backup of
the native paginated history projection, following 035. A fresh catalogue is
native backfill. Only read RPCs are permitted by the probe; the configured model
endpoint is an unreachable local port, with an empty home and no credentials.
There is **no resume or native-file fallback** to fill omissions. In particular,
the legacy transcript lacks the command item that the original 027 live capture
observed. Stored command output and some item timestamps survive in paginated
history; live delta timing and complete provider usage do not.

The small transport is a metadata catalogue plus native documents with provider,
session ID, source/profile, method, capture time and coverage. The Node reader
supports the coordinator’s GET-only mock routes; selecting a document reads the
export, never a provider runtime. Unknown payload fields are preserved. Codex
fork ancestry remains available; no new subagent tree or historical usage total
is inferred. Native Claude assistant usage fields are present, but live result
cost records are absent. Missing usage means unknown, not zero.

**Versions and corpus.** The reader used Codex **0.163.0**, SHA-256
`8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`,
Python **3.14.7**, official `claude-agent-sdk` **0.2.165**, launcher
**0.1.0+dev**, and Node **26.10.0** on macOS arm64. Codex sessions were produced by
the isolated 027/029 research home using 0.162.1. Claude sessions came from the
13 October production launcher browser/API validation and 014 virtual-Node Haiku
launch check. This is compatibility with those small prior corpora, not a
six-month coverage claim or current live-provider qualification.

**Validation:** four Python checks passed against the actual local exports,
including both providers’ real tool results and Codex page/full-read equality;
two Node tests passed for unknown-field preservation and key/identity hygiene.
Ruff lint/format checks passed. Source JSONL hashes, read methods, native RPCs,
cleanup and list/loaded comparisons are recorded in ignored
`experiments/artifacts/058-native-history-access/evidence.json` and its siblings.
The first export had 15 sessions and no Claude tools; the final run adds one
existing tool session. Both runs performed zero inference. Estimated new provider
cost is **USD 0**; original session cost, actual subscription billing and assistant
implementation effort are separate.

[Runnable exporter, reproduction and exchange contract](../../spikes/058-native-history-access/README.md).
Acceptance applies RC-01/02/05/07/08 from the
[runtime contracts](../../../docs/runtime-contracts.md). Resume/fork/send and
retention policy remain deferred to continuation/live-control slices; no product
decision was needed for this passive read boundary. The rich rendering and
content-stress fixture study is [059](059-historical-viewer.md).

## Long-history review extension — 24 October 2026

The catalogue now retains the original 16 experiments and adds **seven real
everyday conversations**. Selection scanned existing local history read-only;
only selected files were copied into isolated reader homes. No ordinary profile
was passed to a provider process, and original hashes remained unchanged.

| Native source | Returned size | Rich evidence |
| --- | --- | --- |
| Codex A | 1,290 items / 28 turns | Mermaid in three assistant messages, compaction and image references |
| Codex B | 1,300 items / 19 turns | Tool work and compaction; math-like markers were source/tool content |
| Codex C | 3,948 items / 51 turns | 40 embedded tool images, substantial command traffic and compaction |
| Codex D | 634 items / 15 turns | Two user-image references and eight embedded tool images |
| Codex E | 144 items / 5 turns | Actual display/inline TeX in two final responses, plus a commentary formula |
| Claude A | 652 visible messages | Usage/cache fields, 298 tool calls and ten embedded tool-result images |
| Claude B | 434 visible messages | Usage/cache fields, one user upload and twelve tool-result images |

Codex **0.164.0** returned actual `agentMessage.phase` values `commentary` and
`final_answer`; this distinction can be displayed without guessing. Its native
history reads took **0.066–0.408 seconds** locally, excluding snapshot creation
and browser work. Claude SDK **0.2.165** helper reads for the selected examples
took approximately **0.4 seconds** each. Those are local observations, not remote
latency commitments. The seven pretty-printed documents occupy **57.6 MB**; the
viewer still transfers complete documents, including embedded images.

The important coverage surprise is Claude's selected-chain semantics. A source
file containing 5,767 user/assistant records yielded only four visible messages
through the official helper. SDK source inspection explains that it follows the
latest main parent chain and intentionally does not follow the logical parent
across compaction. Pagination does not recover those excluded earlier messages.
Additional native helper probes found the larger usable examples above. We did
not add a private transcript/recovery parser to circumvent this behavior.

Ten existing typed image references were copied with hashes and an explicit
**current-file-at-export** qualification; other references remain unavailable.
The copies do not establish historical byte equality. Payloads remain unchanged,
and an additive asset sidecar tells the mock host which exported files it may
serve. User uploads and tool-returned screenshots are represented; dedicated
image-generation-result coverage has not been established. Initial math marker
counts matched source/tool text and did not establish mathematical conversation
coverage. UI review caught this; the supplemental Codex E capture was separately
qualified against actual native assistant prose, excluding code and imported
tool wrappers. Its explicit item positions are retained in the local evidence.

These findings make long-trace density and navigation review meaningful. They
also expose separate future work: incremental reads, asset retrieval, coverage
across compaction and billing/context derivation. DuckDB/MotherDuck ingestion is
still a separate path; this extension does not add a storage schema or S3 client.

**Validation:** seven native-export Python checks, two Node transport checks and
Ruff passed. The final private `long-corpus/qualified-run/evidence.json` records
source hashes, empty Codex loaded registries before/after, allowed read methods
and process cleanup. No turns, login or provider inference occurred; new provider
spend was **USD 0**. See the [extension runbook](../../spikes/058-native-history-access/README.md#everyday-history-extension-24-october-2026).
