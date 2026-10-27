# Orchestrator application

The first production-workspace application foundation. It reads the real local
coordinator's identity and empty owned-run inventory, preserves last-known facts
when that connection fails, and prepares text using the current public AIUI prompt
record/compiler. Preparing a prompt does **not** submit it to an agent.

Run the repository's development supervisor for an isolated frontend/backend pair.
For frontend-only work, from `typescript/`:

```sh
PDUM_ORCHESTRATOR_URL=http://localhost:PORT pnpm --filter @habemus-papadum/orchestrator-app dev
pnpm --filter @habemus-papadum/orchestrator-app typecheck
pnpm --filter @habemus-papadum/orchestrator-app test
pnpm --filter @habemus-papadum/orchestrator-app build
```

`PDUM_ORCHESTRATOR_URL` configures Vite's `/api` proxy. `PDUM_VITE_CACHE` may select
an instance-owned cache. The app uses source-linked public AIUI packages through
the workspace's catalog/override policy; it has no separate install or lockfile.
Vite runs the AIUI source processor before Solid and deduplicates the Solid runtime.

## Boundaries

- `model/prompt.ts`: pure context resolution, exact text → semantic record →
  structured rendering → provider input preview. Uses shared `agent-core` scope
  helpers. Unsupported rich parts fail rather than disappearing.
- `model/connection.ts`: coordinator read ownership, request supersession and
  retained stale observations. This does not create an agent connection.
- `model/store.ts`: scoped durable state, declared controls and explicit actions.
  Working model/directory overrides remain selected; no saved defaults are written.
- `model/graph.ts`: disposable cells over those durable owners, plus the public
  AIUI tool surface. UI/graph hot changes can retain draft/prepared state; changing
  durable wiring or reloading the page is a separate boundary.
- `ui/App.tsx`: compact HP-design presentation, instance details and a text-only
  prepare surface. The component reads cells and dispatches the same actions as tools.

The standalone mount explicitly accepts `page.tsx` hot updates and replaces only
the rendered UI. Its direct unaccepted `store.ts` dependency preserves a full-reload
boundary for wiring changes. The cell graph uses AIUI's `hotCellGraph`; pure cell
mappers are synchronous and declare semantic equality where a freshly allocated
but unchanged result should not republish. Diagnostics are not disabled.
Solid automatic component refresh is disabled for the qualified RC/compiler set;
the explicit Vite page-remount boundary was verified to preserve draft, working
model and prepared snapshot. Store/wiring changes may still reload the document.

The public tool namespace is `orchestrator`: standard report/set/source/locate
inspection plus refresh, prepare and reset-overrides actions. A prepared snapshot
remains immutable if the draft changes; the UI marks it as out of date until the
operator explicitly prepares again. Native preview objects contain content only,
not a complete dispatched RPC or an assertion of provider acceptance.

The layout starts from the local `create-aiui` template with its scenery removed.
It imports `aiui-design/site.css`, not the private FAI design package. No internal
dock/oracle/live package is a production dependency and no key is injected here.

## Status and validation

S0 is foundation work: actual management reads and offline prompt preparation.
There is no profile editor/auth workflow, native launch, conversation connection,
model catalog, saved-default action, worktree provisioning or live Send operation
yet. Those belong to the accepted S1/provider slices; the empty inventory is not
a set of simulated agents. Native-history/rendering and richer authoring also
remain separate work.

Applicable contracts are RC-07/09/11/12: transport failure retains evidence rather
than declaring termination; unknown state stays unknown; coordinator readiness is
not provider authentication; preparing/inspecting content does not submit work.
Pure tests cover exact compiled text, context/override isolation, frozen snapshots,
unsupported rich input and stale/superseded observation behavior. Actual backend,
browser, source/HMR and instance-isolation qualification is owned by the combined
S0 slice. No provider model call is required by this app's tests or build.
