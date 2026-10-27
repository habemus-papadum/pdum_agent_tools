# Historical viewer: review and handoff

**24 October 2026 — this mock phase is reviewed and wrapped up.** The user is
satisfied with the historical spike and wants to move to other orchestrator mocks.
No further history experiment is a prerequisite. Preserve the remaining questions
below for the relevant implementation slice; do not keep expanding this mock
simply because more provider behavior can be investigated.

This handoff covers the work done in the forked historical-viewer conversation
following the original Round A mock. It includes related changes to 058's evidence
collection, 055's preview transport, and shared planning documentation. No commit,
push, release, production-library implementation or upstream AIUI edit was made.
The checkout also contains independent authentication-study changes; preserve them.

## Where the work stands

The viewer is a disposable, read-only Solid/AIUI application over **actual native
history exports**. It now demonstrates dense long-trace reading, family navigation,
time/gap navigation, qualified metrics and rich-message discovery. It provides
useful input for later SDK/component design; its temporary types and transport
are not production contracts.

The historical/statistical distinction remains important:

- Historical browsing uses Codex app-server and official Claude SDK history data.
  The mock reads previously exported files through local GET endpoints.
- DuckDB/MotherDuck is the separate ingestion/statistical path. Future enrichment
  may link the two with source attribution; this viewer does not silently treat
  ingestion fields as native API fields.
- Browsing never resumes, forks, starts or attaches an agent. Refresh rereads
  exports; it does not recollect history or invoke a provider.

The user also reviewed the separate authentication direction. Its owner recorded
that in [060's handoff](../060-authentication-flows/HANDOFF.md). Together these
finish the Round A interaction-review gate; live authentication policies remain
open. The [round tracker](../../../docs/plans/agent-orchestrator/next-mock-rounds.md)
is the overall staging reference.

## What changed during this fork

1. **Density and hierarchy.** Outline/compact/reading modes apply to prose.
   Consecutive commands, patches, reasoning and operations share rows of expandable
   icon-bearing pills. IDs/full paths moved into inspection. Messages, individual
   tools, native turns and the displayed window can expand/fold. Explicit Codex
   updates can become pills independently of final responses.
2. **Real long histories.** Expanded the original sixteen small experiments to
   23 individual captures, adding everyday work up to 3,948 items and a qualified
   mathematical conversation. Genuine captures and the synthetic renderer bench
   are visibly separate.
3. **Native behavior/availability audit.** Recorded an extensible inventory, then
   collected families and item clocks. Added canonical RC-09/RC-10. Unknown
   native records remain inspectable; source/version and interpretation matter.
4. **Families and time.** Added three selected family bundles, actor navigation,
   lane selection, sequence/calendar axes, reversible gap compression, width
   controls and metric tracks. Gap rules use all recorded activity across the
   selected lanes before item filtering. UTC and elapsed gap durations are visible.
5. **Metrics and operation meaning.** Native tool elapsed and endpoint intervals
   stay separate. Error records, response tokens and actor response models can be
   displayed. Cost/context tracks explain their unavailable data. Child work
   completion, background requests, compaction and qualified Claude command
   notices receive specific presentations without inventing lifecycle facts.
6. **Images, math and discoverability.** Real TeX/Mermaid/code/images render.
   Images use thumbnail → hover/focus preview → click detail → optional pin.
   Image/event finders reveal the first matching record. A mixed-provider rich
   collection adds six direct native-message bookmarks and shareable local links.
   It is explicitly an independent collection, not a fabricated family.
7. **Keep the learning.** Added the Markdown availability ledger and linked it
   from the working method, client-foundation card and relevant component owners.
   Producer, reader and adapter versions; absent versus uncollected fields; actor
   identity; timing scope; and repeated usage must inform future SDK types.

## Read these documents first

| Document | Purpose |
| --- | --- |
| [Viewer report](../../docs/spikes/059-historical-viewer.md) | High-level implemented interactions, iterations, validation and loading limits. |
| [Availability ledger](../../docs/spikes/059-data-availability.md) | Standing input to future type/schema design; update it as understanding changes. |
| [Behavior inventory](../../docs/spikes/059-evidence-inventory.md) | 27 provisional evidence questions and observed/source-only/missing distinctions. |
| [Families and duration](../../docs/spikes/059-agent-family-evidence.md) | Exact collection scope, relationship gaps, clocks and timing semantics. |
| [Rich-message examples](../../docs/spikes/059-rich-messages.md) | Direct links and qualification of actual prompt images and assistant equations. |
| [058 evidence/runbook](../058-native-history-access/README.md) | Native read methods, isolated snapshots, collectors and reproduction. |
| [Runtime contracts](../../../docs/runtime-contracts.md) | RC-01–10, especially passive history, provider lifetimes and clock/duration scope. |

The [visual direction](../../../docs/plans/agent-orchestrator/visual-direction.md)
and [working method](../../../docs/plans/agent-orchestrator/methodology.md) retain
the user's broader preferences: compact expressive HP styling; explicit intent;
product questions asked when needed; changing evidence recorded before extracting
production schemas. These remain provisional design preferences, not frozen UI.

## Evidence that matters for architecture

- **Codex family:** one parent plus all five referenced children, 5,785 items,
  104 turns and 61 item-history pages. Page/full-read identity and payloads agree.
  Every returned item entry has producer timestamps in this selected corpus; one
  turn lacks an end/duration. This is not a guarantee for every history format.
- The parent's **53 child-completion activities** refer to recurring child work
  across five children. Completion is not process termination. Typed interactions
  identify activity/targets but omit the full sent-message body. All family
  `rootTurnId` fields were absent despite other known relationships.
- **Claude families:** one main plus 25 listed children, and a contrasting main
  plus four children. Public helpers read all listed children but omit many
  parent calls/relationship identifiers from the selected visible chains. The
  nested view resolves six parent links and leaves nineteen unknown; it does
  not attach unknown children to the main agent by default.
- Claude child identity is root session plus agent ID. A null parent-agent ID can
  mean main parent **or missing metadata**. Sidecar existence is not proof that
  the SDK returns a usable parent tool ID.
- Claude's nested collection repeats eleven native message UUIDs and six response
  IDs across documents. Known family response totals deduplicate provider/response
  identity; shared ownership remains unassigned. Do not sum lane totals blindly.
- **Time sources differ.** Codex full-thread data exposes turn clocks in seconds;
  paginated item-entry wrappers add millisecond item clocks. Keep those wrappers.
  Claude's public message helper drops original wrapper timestamps. Its time view
  is explicitly unavailable rather than inventing message positions.
- **Duration has scope.** Reported tool elapsed, producer endpoint interval,
  client-observed span, deliberate wait and background lifetime are different.
  Long-running work is not automatically unhealthy; missing ends are not zero
  or proof of still running today. Parallel durations do not sum to wall time.
- **Finality differs.** Codex preserves explicit update/final phases. Claude's
  `tool_use`/`end_turn` stop reasons are shown separately and are not treated as
  proof that the controlling SDK query is complete.
- **Rich examples:** three actual human image prompts, two mathematical final
  responses and one mathematical update. Human TeX prompts, image-plus-TeX in a
  single human prompt and assistant-authored images were not found in the
  inspected corpus. Tool images and user-role system/teammate notices were
  excluded from those claims. These are evidence gaps, not capability verdicts.

## Code and ownership map

| Location | Work from this fork |
| --- | --- |
| `059/src/model/native.ts`, `presentation.ts`, `rich.ts` | Native projections, semantic operations, phases, images/usage, exact clock joins, detail levels and grouping. |
| `059/src/model/family.ts`, `timeline.ts`, `map-metrics.ts` | Qualified relations, deduplicated known usage, selected-lane time transforms, bounded SVG geometry and metric overlays. |
| `059/src/model/examples.ts` | Native-identity bookmark resolution; no guessed ordinal fallback or fabricated ancestry. |
| `059/src/model/store.ts`, `graph.ts` | Scoped controls/actions, durable view state, cancellable GET cells, family/actor selection and derived initial URL example focus. |
| `059/src/ui/`, `style.css` | Dense transcript, family/collection navigation, minimap, compact inspection, rich content and image lenses. |
| `059/*browser-check.mjs`, model tests | Runnable actual-browser and model regressions. |
| `059/audit-*.mjs` and tests | Read-only evidence inventory and recorded-event timing analysis. |
| `058/extend_corpus.py`, `collect_*_family.py`, `collect_rich_examples.py`, related tests | Isolated native evidence collection and rich-example qualification. |
| `055/family-reader.mjs`, `serve.mjs`, associated tests | GET-only family/collection transport and explicitly listed local assets. |
| Shared docs | Availability/inventory/reports, RC-09/10, visual preferences, methodology, relevant component cards, round tracker and index links. |

Paths abbreviated 055/058/059 above are sibling spike directories. No new
production dependency or package API was introduced. Existing source-linked
AIUI supplies cells, controls, Lens, TeX, Mermaid, JSON/Text views, page boundaries,
tooling/dock and command-map foundations. No upstream AIUI patch was made.

The current dirty tree includes **separate 060 authentication work** and shared
planning edits from its owner. Do not assume every modified line belongs to this
fork or stage everything indiscriminately. The handoff is descriptive, not an
instruction to commit. No branch/commit/push was created here.

## Preview and local data

The shared lab was checked running at `http://localhost:56044/` when this handoff
was written. Useful entry points:

- `/history/` — individual captures and family/collection chooser.
- `/history/?group=codex-work` — complete selected Codex family; choose Axis → time.
- `/history/?group=claude-nested` — nested family with explicit relationship gaps.
- `/history/?group=rich-messages` — opens a genuine human image prompt immediately.
- `/history/?group=rich-messages&example=math-final-state-model` — final equations.
- `/history/?group=rich-messages&example=math-update-validation` — update formula.
- `/059-historical-viewer/HANDOFF.md` — this document rendered by the preview host.

**Ownership snapshot, not a permanent PID:** `/__instance` reported PID **81340**,
instance ID **`4f1e49da-5a7c-489a-afc6-6ffce71e4206`**. Recheck identity before
stopping anything. Do not kill an unrelated listener if this instance has changed.
Temporary QA servers were stopped; the shared preview was left running.

To start another isolated preview, run from `experiments/`:

```sh
PORT=0 node spikes/055-orchestrator-mock-lab/serve.mjs
```

Use `PORT=56044` only when that port is available. Each instance has its own
identity, temporary state and Vite cache. The browser's ordinary refresh is
sufficient after source updates; restarting is needed for Node host/route edits.

All raw data is ignored and local under
`experiments/artifacts/058-native-history-access/`:

| Input | Location / contents |
| --- | --- |
| Individual captures | `catalog.json`, `documents/`, `assets/`: original 16 experiments plus seven everyday captures. |
| Codex family | `families/codex-20261024T155028Z/`: native documents, item pages, relationships, timing and hygiene evidence. |
| Claude nested / contrast | `families/claude-20261024-d2/`, `families/claude-20261024-c2/`: documents, relationship gaps, helper/hash evidence. |
| Rich collection | `rich-messages/`: three unchanged documents, six bookmarks, seven copied assets and explicit missing cases. |
| Audits | `experiments/artifacts/059-evidence-inventory/`: pointers/hashes, counts, timing and family usage overlap. |

These files are not in Git and must not be committed. A new checkout will not
magically contain them; collectors take explicit existing sources and private
selection manifests. Missing exports remain visible as unavailable. The original
16-session reproduction references old temporary research paths that may vanish;
do not silently substitute the developer's normal home as a new source.

`PDUM_HISTORY_EXPORT_DIR` changes the individual export root.
`PDUM_HISTORY_FAMILIES_CONFIG` selects explicit local family/collection runs; it
is disposable lab input configuration, not a new ingestor/profile schema. The
055 README documents its shape and route behavior.

## Validation and cost

Recorded checks, with the revision they qualified (these are not a claim that
all browser suites were rerun for this documentation-only handoff):

| Check | Recorded result |
| --- | --- |
| Latest viewer model/cell suite | 40 passing tests. |
| Latest family/collection reader and actual HTTP tests | 12 passing tests. |
| Individual-history browser suite | 54 checks passed during the density/family revisions; real math, Mermaid and image lenses included. |
| Family/time browser suite | 53 checks passed at 1440×900 and 390×844. |
| Rich-message browser suite | 63 checks passed at 1440×900 and 390×844; six fresh direct links passed five focused checks each. |
| Native export/family collection | Seven original/extended export Python checks; five Codex-family checks; five Claude checks for each selected family; source hashes and cleanup qualified. |
| Other checks | Typecheck, Vite build, strict MkDocs, Ruff on new collectors and relevant Node audit tests passed. |
| HMR | UI/graph edits preserved selection/detail; family iteration preserved family, actor, lanes and axis. Store edits still reload by design. |

Run from `experiments/`:

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run ../059-historical-viewer/src/model
pnpm --filter @agent-spike/orchestrator-mock-lab build
node --test spikes/055-orchestrator-mock-lab/family-reader.test.mjs spikes/055-orchestrator-mock-lab/server.test.mjs
node --test spikes/059-historical-viewer/audit-evidence.test.mjs spikes/059-historical-viewer/audit-recorded-timing.test.mjs
```

Browser checks export `runHistoryBrowserChecks`, `runFamilyBrowserChecks` and
`runRichExamplesBrowserChecks` from their corresponding `.mjs` files. Run them
in an isolated preview tab; they intentionally change view state. Use the rich
collection URL for its initial-link checks. Measure actual `innerWidth/innerHeight`
when emulating—this Chrome session had 175% zoom, so physical dimensions differed
from CSS dimensions. Use the detailed reports/runbooks for native Python checks.

Remaining diagnostics were recorded rather than suppressed: bounded
`HOT_SCOPE_TIME` observations (up to roughly 40 ms during development; final rich
runs 10.3–18.8 ms), large Mermaid/ELK/Mosaic build chunks, and an earlier AIUI Lens
focus-out warning when replacing a focused source. Fresh family/rich qualification
had no browser errors. Screenshot inspection was done inline; no saved screenshot
artifact is claimed where the browser tool rejected file output.

**New provider inference spend for this fork: USD 0.** Work reused existing
history and native read helpers. This excludes historical session usage and the
implementation/research agents' own execution cost. Original histories were not
modified, credential stores were not accessed, and no new provider turns were submitted.

## Defer these until their owning slice needs them

- True incremental document/family loading, worker projection and metadata caches.
  The Codex family response is about **74.5 MB**; current metadata extraction also
  parses full selected files. Windowed mounting is not cheap transport/parsing.
- True thumbnail generation/caching and S3 retrieval. Current thumbnails use full
  bytes; copied reference files are qualified as export-time copies, not verified
  historical originals.
- Additional model/effort/tier, historical usage/context and pricing sources.
  No production cost estimator or context reconstruction is implemented.
- Complete inter-agent mail and parent linkage, Claude timestamp enrichment,
  richer fork/continuation views, and qualifications for currently missing rich
  message cases. Keep public SDK/native boundaries and source attribution clear.
- Automatic gap/health policy, graphics backend choice, shared component extraction
  and general live/history parity. The 054 live mock was not rewritten in this fork.

These are follow-ups, not blockers to finishing this mock phase. Do not infer
complete provider support, crash recovery, live control or six-month compatibility
from the selected historical examples.

## Suggested next work for the main agent

Move to the agreed **Round B** mocks. A useful first slice is **061 ingestion and
statistics**, followed by **062 launcher connections** and **063 profile workbench**
as their boundaries permit. Read each existing ingestor/launcher config owner
before sketching forms; do not introduce an unrelated durable configuration scheme.
Use the working method to ask only product questions now required by that slice.
Round C continuation and task launch/shutdown remain after B review.

Do not start a new SDK/library extraction just to tidy this spike. Keep the
reviewed interactions and availability ledger as design inputs, retain the local
preview for reference, and return to the deferred history questions when a concrete
feature requires them. No Round B or C implementation was started in this fork.
