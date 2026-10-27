# Orchestrator app

Follow the repository's [AGENTS.md](../../../AGENTS.md). This private app lives in
the production TypeScript workspace; dependencies and lockfile belong to that
workspace, never here. The local AIUI scaffold supplied the initial wiring and
its placeholder scenery has been removed.

Keep pure operations in `model/prompt.ts`, durable ownership/controls/actions in
`model/store.ts`, disposable cells in `model/graph.ts`, and rendering in `ui/`.
The app uses public source-linked AIUI packages. Do not add the internal dock,
oracle or a provider connection just to render this foundation.
