# 061 — Ingestion and statistics

**24 October 2026.** A disposable working application over real selected Codex
and Claude data. [Open the local study](http://localhost:56044/ingestion/) or read
the [runbook and limitations](../../spikes/061-ingestion-statistics/README.md).

The operator can scan sessions by known cost, filter provider/project, inspect
tool/error and usage coverage, run the existing TypeScript analysis queries, edit
the ingestor's actual `history.yaml`, and perform a real incremental sync. The
configuration panel is secondary to the data; source provenance and run evidence
have their own compact views. This uses the existing Python ingestor and
TypeScript query toolkit, not a replacement configuration or analysis schema.

The selected corpus is six real transcripts copied from 058's private selection:
four Codex and two Claude. SHA256 evidence verifies the original and copied files;
only the copies are ingested. The first run produced six threads and 7,870 items;
the next browser-triggered sync correctly skipped all six unchanged files.
No original agent state, credentials or provider runtime was modified.

The interesting complications are data meaning and scope. The existing Claude
ingestor synthesizes token counters from response usage; those are not native
context occupancy. The display therefore leaves Claude context unknown, and the
context/compaction presets explicitly use Codex records. The corpus omits native
Codex catalogue/projection/log databases, so its item-completed fallback and
coverage notes remain visible. Several existing toolkit queries need source-key
qualification when a thread is copied into multiple roots; this study refuses
that unsupported preset case rather than presenting a multiplied aggregate.

The initial **$529.34** is known historical API-equivalent usage under the saved
**17 October 2026** pricing snapshot, with four unpriced events. It is neither
actual subscription billing nor experiment spend. New provider inference is
**$0**; implementation-assistant usage is not exposed.

The UI is actual Solid/AIUI with scoped controls, cells, source tooling and the
shared keyboard command map. It uses dense tables and a collapsible native YAML
editor. Mosaic coordinated filtering, cloud publishing, target switching,
automatic ingestion, fine-grained phase progress and history continuation remain
follow-ups. Existing analysis queries run against local DuckDB; the browser is
not loading raw transcripts into a new warehouse.

Qualification is intentionally focused: 18 real browser checks at 390×844, actual ingestion and incremental behavior,
invalid configuration preserving the previous file, reversible configuration save,
real SQL queries, typed frontend compilation, and desktop/phone review. The
readme provides the browser check and source evidence locations. RC-09/RC-10
govern interpretation; RC-07 governs unknown operation outcomes. No production
SDK/library, credentials, raw captures or cloud writes were added.
