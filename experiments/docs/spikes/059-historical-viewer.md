# 059 — Dense native history reader

**24 October 2026 · reviewed; this mock phase is wrapped up.** The historical viewer now uses substantial
real conversations and explores the compact transcript style requested in review.
Open `/history/` in the shared mock lab. The seven **Real work** entries include six substantial conversations with
434–3,948 native items/messages and a 144-item mathematical-prose supplement;
the sixteen **Small experiments** are genuine
bounded probes. The **Synthetic rendering bench** remains a separate authored
exercise. Source details and qualification are in [058](058-native-history-access.md).

The follow-up [rich-message collection](059-rich-messages.md) now supplies six
one-click examples from actual human image prompts and mathematical assistant
updates/finals. It is labelled as independent captures, with missing cases
explicit; the group is not an invented parent/child relationship.

## What changed

The [handoff](../../spikes/059-historical-viewer/HANDOFF.md) consolidates this fork's
changes, local evidence, validation, preview ownership and deferred work. The main
agent can proceed to the other agreed mocks without extending history work first.

- **Outline, compact and reading** levels apply to user and agent prose. Outline
  elides it to a short excerpt; individual messages expand in place. Native Codex
  turns and the displayed window have expand/fold actions too.
- Consecutive commands, patches, reasoning and other tool activity share rows of
  icon-bearing pills. Expanding one reveals its exact content and raw-record
  access. Grouping preserves chronology and never crosses a native turn boundary.
- Native Codex phases distinguish **update**, **partial** and **final** when
  supplied. An absent phase stays unknown; the last displayed message is not
  automatically a final response. Tool-returned images in Claude user-role
  containers remain tool activity, not human uploads.
- The default right pane is an **item-order minimap**. Color shows user, agent
  and work, with error, compaction and image markers. Clicking jumps to the
  corresponding region; Start/End and keyboard navigation work beyond the
  currently mounted window. The outlined area represents the display window,
  not a claim about wall-clock duration or tokens.
- IDs, complete paths and provenance moved into compact optional inspection.
  Metrics use reported counters and explain unavailable values on demand.
- Image thumbnails use AIUI's Lens: hover/focus preview, click detail, optional
  pin beside the trace. Native embedded images and explicitly exported local
  files work. Missing references and failed loads have distinct presentations.

These are disposable experiments in the shared [visual direction](../../../docs/plans/agent-orchestrator/visual-direction.md),
intended to inform both live and historical transcripts. The live study has not
been rewritten, and no shared production component has been extracted.

## Family and time iteration — 24 October

The **Captured family** selector now opens the qualified Codex family (main plus
five children), the Claude nested family (26 actors) and the Claude relationship-gap
example (five actors). The original 23 individual captures remain separate.
Each actor opens its own transcript. Checkboxes choose map lanes, “only” isolates
one, and “All lanes” restores the collection. Missing parent evidence remains
visible; a child work-completion pill does not imply that its process ended.

The navigator offers **sequence** and **time**. Sequence is relative item order
inside each actor, not simultaneous activity across actors. Time uses qualified
producer clocks on one UTC axis. Claude's missing clocks produce an explicit
unavailable view with a button to choose sequence; no positions are invented.
The displayed transcript remains windowed independently of navigation.

Time gaps can be folded at a visible, selectable threshold (initially 30 minutes
for this experiment). Gaps are computed from all records in the selected lanes,
before applying the item filter. One actor's activity therefore prevents another
actor's quiet interval from being folded away. Stripes and elapsed-time labels
mark folded spans; click a span or use the gap list to expand/refold it. Selection,
original time range and record counts remain intact. “No recorded activity” is
not a claim that no unobserved work occurred.

Tracks include activity, explicit errors, reported duration, known response tokens
and response model. Duration/token widths use a labelled log scale and the largest
value per display bin. Token values are shown once per response per lane; selected
family totals deduplicate provider/response identity, while shared ownership stays
unassigned. Cost and context choices explain their unavailable data rather than
rendering invented zero lines. Per-item child-creation model fields never color
the parent as though they were its own response model. Width is adjustable, and
large lane sets scroll horizontally inside the navigator.

**Find images** and **Events** jump to real matching records in the selected actor
and expand the first match. Codex commentary can optionally become pills. Claude
shows “to tools” or “response ended” from its native stop reason; this is separate
from Codex's final-answer phase. Recognized compact-command/output and task notices
show their interpretation basis. Reported tool-duration badges and raw producer
endpoints remain separate; the inspector also shows the derived interval.

The [availability ledger](059-data-availability.md) is the standing design input
for eventual production data types. It records native versus derived fields,
provider/reader/adapter version distinctions, missing-data states, source ownership,
relationship gaps, clocks and repeated usage. It should evolve as new evidence
arrives; current mock interfaces and transport envelopes are not frozen schemas.

Validation: **37 pure/cell checks**, **53 family browser checks at 1440×900 and
390×844**, and the retained **54 individual-history browser checks** (1675×636)
passed. Eight reader/HTTP checks passed, including real isolated servers and
native-family smoke reads. Shared typecheck/build and strict documentation checks
passed. UI and graph hot edits preserved selected family/actor, lane selection,
axis and detail level. Final family-browser consoles had no errors/page faults;
remaining `HOT_SCOPE_TIME` observations were 8.2–36.5 ms. No warnings were suppressed.
The older image-lens focus-out diagnostic can still occur during individual-history
source replacement, as recorded in the earlier revision.

The Codex family bundle transfers approximately **74.5 MB** uncompressed. The
metadata catalogue currently parses complete selected files server-side, and
family projection remains on the browser's main thread. Bounded SVG paths and
windowed transcripts reduce rendering work, not data transfer. Incremental family
loading, worker projection and thumbnail retrieval remain measured follow-up needs.

## What the real data taught us

**Small samples hid both navigation problems and API limitations.** The larger
corpus includes real assistant Mermaid and mathematical prose, user-upload images, tool-returned
screenshots, commands, file changes, errors and compaction. Dedicated
image-generation-result coverage is still missing. A supplementary native session
qualifies equations inside actual final responses; initial broad math-marker
searches had only matched tool output/code and were insufficient evidence. Rich content in a tool result
is not automatically an assistant-authored answer.

Codex preserves its explicit message phase. Its native historical projection
omits token-count/usage-record events, so missing historical usage is not fixed
by merely adding a display field. Claude's helper preserves response-level
input/output/cache counters, but follows the selected visible parent chain;
a much larger file can yield only a few messages after compaction. We preserve
that API boundary instead of reconstructing private session internals.

Request IDs deduplicate Claude totals. Input, cache read and cache creation remain
separate. Tools have no independently inferred model bill. **Cost estimation is
not implemented; historical context occupancy is not established.** Cumulative
token use is not context occupancy. Any later enrichment from ingestion must
identify its additional source and coverage explicitly.

## Loading and image retrieval

The viewer mounts a window of 80, 160 or 320 native records. Filtering and the
minimap operate over the complete selected export, and jumping outside the window
moves it without discarding native records. This limits rendering work; **it is
not network pagination or streaming JSON parsing**. The seven new documents occupy
57.6 MB on disk, including embedded images. Large-document transfer, parse and
projection remain measurable work even in outline mode.

The mock host serves only listed raster files under its local export asset route.
Ten existing referenced files were copied at export time. The preview explicitly
says their historical byte equality is unverified: the same path could now contain
a different image. Native records remain untouched; the optional sidecar resolves
references to copied files. Embedded images retain their original native origin.
Thumbnails currently scale the full image, so they do not reduce transferred bytes.

This is a temporary rendering seam, not a new durable storage schema. The current
ingestor's `item_blobs` stores native item JSON; it does not implement an S3 binary
asset store. MotherDuck remains the statistical/ingestion path. Later work can
link records by native/source identity and resolve assets through local or S3
adapters. Cloud credentials, thumbnail generation, caching and stable asset
identity require a separate storage slice.

## Contracts, implementation and acceptance

The slice follows pure projections → scoped controls/cells → components → app.
Actual Solid/AIUI controls, cells, Lens, JSON/Text views, TeX, Mermaid, page boundary,
command map and local development dock remain in use. No upstream AIUI or
production package changed. The compact styling derives from Habemus Papadum's
paper/slate/indigo palette with semantic activity colors.

RC-01/08 preserve stored-versus-live and provider-specific meanings. RC-02/05 keep
history inspection passive: the browser performs local GETs and exposes no
resume, fork, login, turn or subscription action. RC-07 keeps missing fields,
native errors and superseded reads explicit. The 058 extension independently
qualified copied native history reads and unchanged original transcript hashes.

The current model checks cover native chronology/identity, missing phases, image
origin, asset resolution, markup/math, request deduplication, display-window
navigation, filter changes and superseded document reads. Real local HTTP checks
cover exported assets, unknown references, read-only methods and server isolation.
Browser checks exercise actual long captures, rich rendering, Lens/pinning,
keyboard operation and phone layouts. See the README's dated validation record
for the final counts and remaining performance diagnostics.

The earlier 19 October qualification was nine model checks and 23 browser checks
against the small corpus; those numbers are historical evidence, not claims about
this revision. New provider inference spend for the 24 October work is **USD 0**.
Raw histories, images and native evidence remain ignored and local.

## Next review

The follow-up [behavior evidence inventory](059-evidence-inventory.md) records
the operator's time/gap, settings, background-work, subagent and image-placement
requests. It audited the original 23 real exports before this iteration. The
family/time mock now incorporates the qualified subset; automatic gap policies,
additional enrichment and richer message linkage remain open.

Review the same long trace in all three detail levels, expand a short sequence of
work, jump near its end, and inspect an image. Decide whether the density and
minimap make navigation easier before extracting reusable pieces.

Still open: fork-tree placement; incremental catalogue/document APIs and rendering
virtualization; source coverage across compaction; true thumbnail retrieval;
S3-backed assets; telemetry enrichment and price/context computation. None is
silently selected by this mock. [Runbook and validation](../../spikes/059-historical-viewer/README.md).
