# 069 — Provider/history evidence register

Read the [short report](../../docs/spikes/069-provider-history-matrix.md) first.
The supporting matrices are:

- [History and continuation](history.md): reading, ingestion, replay, resume/fork,
  compaction and identity.
- [Attachment and control](live-control.md): live joins, multiple clients, input,
  callbacks, interruption, tools and children.
- [Content and measurements](measurements.md): transcript completeness, images,
  clocks, tokens, cost, context and diagnostic coverage.
- [Ownership and storage](ownership.md): connection/runtime/owner loss and the HP
  Node/browser boundary.

The later [070 evidence](../../docs/spikes/070-hp-backend-parity.md) qualifies HP
storage/restore/fork/accounting helpers in both hosts. Each matrix has an update
note distinguishing that new research path from the original 039–052 baseline
and from still-unimplemented production integration.

## Scope and status labels

This is a synthesis on **25 October 2026**, not a fresh compatibility run against
every installed provider. It reads local reports and selected implementation
source. A successful small probe does not establish universal protocol support.

| Label | Meaning |
| --- | --- |
| **Observed** | A cited experiment exercised the behavior against the real named provider or real local host mechanism. The linked scope/version still applies. |
| **Local-tested** | Actual local implementation exercised with scripted provider events, MessagePorts, files or processes. This establishes our mechanism, not remote model compatibility. |
| **Source** | Implementation or public declaration inspected; not newly exercised here. |
| **Proposed** | Desired direction or architectural recommendation; not shipped behavior. |
| **Gap** | Absent from our present implementation or this source surface, as stated. This is not a claim that the provider can never support it. |
| **Unqualified** | The current evidence does not establish the behavior. It must not become an implicit promise. |

HP entries refer to research code, not a distributable HP client/runtime package.
“Same core” does not upgrade a Node-only live check to a browser live check. Tables
call out that difference where it matters. Claude entries distinguish current
SDK-based integration from the new 068 raw-feed investigation.

## Evidence/version register

| Family | Evidence boundary |
| --- | --- |
| [025–034 Codex round](../../../docs/codex-client-findings.md) | 14 October: installed Codex **0.162.1**, release source `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; separately built clean source `6c372fbef45f730b6d8aa727b0ec8332365588db`. They are not the same executable. macOS arm64, Node 26.10.0, Chrome 155 where used. |
| [035 analysis](../../docs/spikes/035-codex-analysis.md) | 16 October: read-only native storage and RPC ingestion; Codex 0.162.1 launched readers, 0.163.0 managed reader, DuckDB 1.5.6. Corpus/version limitations remain in the report. |
| [056 lifecycle](../../docs/spikes/056-codex-inactive-lifecycle.md), [057 live follow-up](../../docs/spikes/057-launcher-inactive-turns.md) | Codex **0.163.0**, source `83086188ae0614bd882818ff1aa23f3194962012`. Native retention conditions are separate from our application policy. |
| [058 native exports](../../docs/spikes/058-native-history-access.md), [059 ledger](../../docs/spikes/059-data-availability.md) | 19–24 October: Codex readers **0.163.0/0.164.0**, Claude Python history SDK **0.2.165**. Source conversation producers vary. A reader version does not identify the producer. |
| [014 Claude](../../docs/spikes/014-claude-app-server.md), [016 client sessions](../../docs/spikes/016-claude-client-sessions.md) | 13 October: Node/browser SDK **0.3.296**, bundled Claude **2.1.296**. Old recommendations are historical, not the new 068 design. |
| [064 continuation](../../docs/spikes/064-history-continuation.md), [065 lifecycle](../../docs/spikes/065-session-lifecycle.md), [067 live/history](../../docs/spikes/067-live-session-workspace.md) | 25 October: Codex **0.164.0**, Claude Code **2.1.310**, Node/browser SDK **0.3.296**, Python history SDK **0.2.165**, macOS. Selected Luna/Haiku flows, not all native operations. |
| [038–052 HP](../../../docs/hp-agent-findings.md), [behavior](../../../docs/hp-agent-behavior.md), [control](../../../docs/hp-agent-parity.md), [jobs](../../../docs/hp-agent-work.md) | 18 October: portable runtime centered in spike039, OpenAI **7.38.0**, Node **26.10.0**, Chrome **155**, Codex reference `6c372fb…`. Browser build, local browser execution and real browser provider checks have separate evidence. |
| [068 raw Claude feed](../../docs/spikes/068-claude-feed-replay.md) | 25 October: Claude **2.1.310**, SDK-free native JSONL, two network clients and separate real Chrome 155 contexts. Six paid Haiku inputs, nine native no-model checks and four transport cases; its report owns detailed qualification. Older SDK observations are not substituted for it. |

For this synthesis, repository HEAD was
`1e897c3bebb9bb6a958018b288cdc86e55c6d60a`, with the existing uncommitted spike
work included. This is a working-tree review, not a claim that every cited file is
already published at that commit. No native executable, model or credential was
invoked by 069.

## Review checks and decision timing

Applicable contracts are **RC-01–RC-13** in the
[runtime ledger](../../../docs/runtime-contracts.md). Review checks are: preserve
connection/runtime/archive distinctions (01–08), keep source/timing/usage scope
and authentication evidence honest (09–11), and distinguish continuation from
reading and draft submission (12), and retain native Claude replay/response
outcomes without server semantic arbitration (13).

Already answered: native history remains ordinary history; analytics uses the
existing ingestor; client coordination is not a reason to add a semantic Claude
server; full replay precedes optimization; one TypeScript HP core serves both
hosts. Delegated: matrix organization and evidence reconciliation. Deferred:
HP durable-storage host, journal-loss presentation, conflicting-action UX and
cross-host continuation. Resolve those when the architecture or implementation
slice first promises the affected behavior. No new product decision is needed
to assemble this report.

Validation for this document-only investigation is source cross-checking and
local link validation. It does not rerun the cited provider probes. Raw captures
remain ignored; exact reproduction commands and historical cost ledgers remain
with each owning experiment. New provider spend: **USD 0**.
