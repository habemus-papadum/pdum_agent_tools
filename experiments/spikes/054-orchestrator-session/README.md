# Session workbench — Solid/AIUI interaction study

**Disposable application study, 19 October 2026.** The UI now uses actual Solid 2
and scoped AIUI controls, actions, cells, Lens and PageBoundary. All conversations,
source bytes, usage and prices remain invented fixtures. No real agent, file or
model operation runs. The earlier plain-DOM runtime has been removed.

## The experience being explored

Keep conversation reading central, with a compact persistent header, usage/status
strip and bottom composer. A small navigator can sit above the transcript or in a
side rail. Choose elapsed time, cumulative known cost, cumulative input/output
tokens or context occupancy; click an item to move directly to it in the transcript.
This compares two placements before choosing one for a concrete spec.

Tiny per-item strips expose usage where the evidence belongs. Model responses own
their request's usage; tools link to that request and have no separate model charge.
Hover a strip for input/cache/output accounting and running totals. Color distinguishes
successful tools, a failed command and running work; compaction has its own marker.
The failed command is a task finding (exit 1), not a fabricated provider failure.

The source flow uses the **real AIUI Lens**: hover/focus preview → click detail.
An application-owned Pin action keeps a source view beside the transcript. Unpin
returns to Lens detail; closing a view leaves selection, comment and prompt state
in the durable store. No duplicate imperative UI runtime owns that state.

## Walk through it

1. Use the cost navigator to jump to `m4`, the larger trace request. Compare its
   input/cache/output strip with the preceding small requests. Hover for provenance.
2. Switch to context and jump to compaction: the working context drops from 59k
   to 16.5k while cumulative token usage and estimated request cost stay unchanged.
3. Open **Study** and change usage coverage. The partial scenario omits `r3`;
   complete fills its invented usage, while compaction cost remains unavailable.
4. Switch between the top chart and side rail. Both navigate the same item IDs;
   transcript order is chronological and is never sorted by cost.
5. Hover/focus the source link in the first tool result, then open and pin it.
   Select lines, add a comment and add the excerpt to the prompt.
6. Choose **Steer turn 12** or **Queue next turn**, then submit and advance the
   scripted receipt. Source/current-file fault cases and uncertain delivery remain
   in **Study**, away from the ordinary conversation flow.
7. Press **Space** for the shared command palette. Its navigation/source commands
   dispatch the same registered actions used by buttons and agent tools. Direct
   shortcuts are suppressed in text inputs. The shared AIUI dock is local lab
   scaffolding and makes no provider connection until explicitly invoked.

## Accounting is explicit

The fixture contains six model requests, seven tools, two user messages and one
compaction event. By default five model requests have usage records. Their known
subtotal is **$0.17296**, **133,700 input tokens** (including **89,000 cached**)
and **8,220 output tokens**: **141,920** input-plus-output tokens. Cached tokens
are a partition of input, not an extra token category to add again. Tool rows
never add a second charge. The last context snapshot is **22,060 / 128,000**.

Prices are deliberately illustrative: $2/M uncached input, $0.20/M cached input,
$8/M output. They are not a current provider price quote or a bill. Unknown request
usage and unknown compaction cost are excluded, so the subtotal is visibly
incomplete even when all six request usage records are supplied. Context is a
snapshot that can decrease; it is not summed into usage. Hatched navigator bars
show where cumulative cost/token coverage is incomplete.

## Actual AIUI layers

- **Pure:** `model.mjs` retains the frozen source/submission/receipt transformations;
  `src/model/telemetry.ts` owns request accounting, attribution and navigation values.
- **Durable:** `src/model/store.ts` declares scope `orchestrator-session`, validated
  controls and registered actions; draft, selection, receipts and scroll positions
  use scoped durable signals. This is HMR continuity, not reload/crash persistence.
- **Disposable:** `src/model/graph.ts` uses `hotCellGraph` for ledger, navigator and
  source projections. `CellView` renders their values and source attribution stamps.
- **UI/application:** `src/ui/App.tsx` reads those declarations. Named `bridgeEffect`
  boundaries perform scroll and source-opening operations; `main.tsx` mounts through
  `PageBoundary`, the shared palette and explicitly requested development dock.

The `orchestrator-session` tool namespace derives `report`, `set`, source-location
inspection and named actions from AIUI. The reporter is a concise totals/navigation
summary, selected-item attribution and item index; it does not repeat the full
transcript, draft text or excerpt payloads. `window.mockSession` is a thin inspection adapter over
those controls/actions, not a second state engine.

The local HABEMUS PAPADUM design package supplies color/typography; status dots,
small transitions and unknown-coverage hatching use its tokens. Pin/unpin is still
application code. Closing the actual Lens from Pin currently uses its rendered
close button; a controlled presentation hook is a candidate upstream improvement,
not a library promise or a reason to copy Lens into this app.

## Run, checks and what to retain

The shared Vite lab serves `/054-orchestrator-session/`; sibling overview is
`/053-orchestrator-overview/`. AIUI's source processor runs before the Solid compiler.
See the lab README for source linking, startup and shared dependency ownership.

From `experiments/`:

```sh
node --test spikes/054-orchestrator-session/model.test.mjs spikes/054-orchestrator-session/telemetry.test.mjs
```

Ten pure tests cover provenance, frozen snapshots, explicit intent, delivery races,
cache partitioning, missing usage, compaction and duplicate request rejection.
Three `cellHarness` tests additionally move each ledger/navigation/source control
dependency and observe the resulting cells through `whenReady`, rather than reading
staged state in the setter's tick. They run in the shared lab's Vitest configuration.

The actual Solid revision passed **29 browser assertions at each of 1440 × 900 and
390 × 844 CSS pixels**, using registered tools in Chrome 155. These cover all three
cells, source listing/reading, telemetry coverage, navigation, Lens/pin state,
frozen prompts, delivery races and viewport geometry. The reusable browser probe is
`session.browser-check.mjs`. Native Space → Navigate → failed-command keyboard
interaction, text-input isolation, and the actual dock's Tools/Source panels were
also exercised without connecting a provider.

Harmless graph and UI source edits retained `performance.timeOrigin`, the draft,
comment, selected lines and control values. The UI edit also retained the pinned
source and the conversation's 240-pixel scroll position. Vite 8 needs the literal
call-site `import.meta.hot.accept()` alongside `hotCellGraph`; the library helper
still owns disposal/rebuild. This is an upstream documentation/tooling candidate.
A focused native Lens trigger can emit an upstream `STRICT_READ_UNTRACKED` warning
when UI HMR unmounts it (Lens's focus-out callback). State and behavior survived;
ordinary interaction checks were warning-free. The source focus/HMR callback is
another upstream candidate, not a compatibility layer added to this mock.

Dev-server restarts during qualification exposed stale optimized-dependency
504 responses from the shared Solid performance-track preload. The lab now excludes
that preload from prebundling; the final hard reload and 29 desktop checks had no
console errors or warnings. Row-level memo boundaries also avoid subscribing every
text field directly to the whole telemetry cell. These are development/rendering
findings, separate from request or session recovery. Prior
plain-DOM evidence is not counted as validation of this rewrite. No paid provider
probes are involved.

Retain interaction findings and these explicit accounting rules for the concrete
spec. The fixture data, rate card and application-specific layout remain disposable.
Before live work, resolve real attribution/coverage, queue ownership, comment
anchoring/storage, acknowledgement reconciliation and historical-file availability.
Source-version changes invalidate a selection for new attachment creation until
that view is selected again; submitted excerpts always retain their original bytes.
Electron/browser packaging and host recovery remain separate decisions.
