# Native history reader

Read-only Round A study: real Claude SDK and Codex app-server history, presented
as a transcript with native provenance, coverage and raw records beside it.
The separately labelled synthetic bench exercises rich content absent from the
captured corpus. This is disposable study code, not a production history SDK.

Run from `experiments/`:

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab dev
```

Open the printed origin at `/history/` or `/059-historical-viewer/`. The shared
055 host serves `GET /__history/catalog` and
`GET /__history/document/<key>` from spike 058's ignored export. Generate that
export following [058](../058-native-history-access/README.md). A missing export
has an explicit error; the synthetic bench remains usable. Refresh rereads local
export files and never regenerates them or contacts a provider.

The catalog groups captures by provider. Search titles/native IDs, open a capture,
filter transcript text or item kinds, and jump by item identity. “Tool” includes
Claude tool-use/result blocks within their original assistant/user records.
“Raw record” selects the original native JSON in the inspector. Source & coverage
shows the method, host/profile metadata, native version, capture time, gaps,
ancestry links and request ledger. Space opens the shared command map; `j`/`k`
move through visible items, `s` toggles sources, `r` raw, and `p` provenance.

The reader has no turn, resume, fork, live-subscription, login or profile-write
action. Stored runtime metadata describes its source, never current execution
elsewhere. Tokens are native response fields, with repeated response IDs counted
once; cost and context occupancy remain unknown. Claude input/cache-read/cache-
creation fields stay separate. Tools do not receive a separate inferred bill.

## Source and framework

- `src/model/native.ts`: pure provider projections, unknown-block preservation,
  response attribution, filters and formatters.
- `src/model/store.ts`: scoped controls, view-only actions and durable selections.
- `src/model/graph.ts`: cancellable local GET cells, projections and standard AIUI
  tools at `window['__native-history']`. Expected read failures are explicit
  values so another source remains selectable; old content is hidden while a
  replacement is pending. Source/record boundaries remount keyed JSON views.
- `src/ui/`: actual Solid 2 components. AIUI supplies `CellView`, controls,
  `JsonView`, `TextView`, `TeX`, `Mermaid`, `PageBoundary`, and the shared 055
  command palette/dock. Markdown tokens are rendered as JSX; Highlight.js colors
  supported code languages. All study CSS is scoped under `.history-app`.

Native envelopes remain unchanged. The rendered projection is deliberately
incomplete: unknown provider items remain inspectable. Embedded raster bytes and
explicit exported assets render as images; references without captured bytes
remain labelled references. Raw HTML is text, and links require an explicit
click. No raw capture is checked into this folder.

## Checks

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run ../059-historical-viewer/src/model
```

In the actual Vite browser page:

```js
const { runHistoryBrowserChecks } = await import('/059-historical-viewer/history.browser-check.mjs');
await runHistoryBrowserChecks();
```

The browser check is inspection-only and emits names, counts and booleans. It
expects both providers and the bounded Claude tool corpus exported by 058; it
does not fabricate missing native evidence. Current results and limitations are
in the [spike report](../../docs/spikes/059-historical-viewer.md).
