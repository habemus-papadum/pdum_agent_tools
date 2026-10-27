# TypeScript workspace

The production pnpm workspace of pdum_agent_tools. It is independent of the Python
uv workspace at the repository root, of the `experiments/` research workspace and
of `examples/`; ordinary Python installation never needs it.

| Package | Role |
| --- | --- |
| [`packages/agent-history`](packages/agent-history/README.md) | `@habemus-papadum/agent-history`: invariant checks, the analysis question set, a session list and a terminal renderer over DuckDB files written by the Python `pdum-history` ingesters. |
| [`packages/agent-core`](packages/agent-core/README.md) | Small portable identity/evidence/management contracts and contextual working settings. |
| [`packages/orchestrator-client`](packages/orchestrator-client/README.md) | Browser/Node management status, run reads and identity-targeted stop. |
| [`apps/orchestrator`](apps/orchestrator/README.md) | Source-linked AIUI app: actual coordinator observation and text prompt preparation. |
| [`tools/dev-instance`](tools/dev-instance/README.md) | One isolated foreground frontend/backend pair via `pnpm dev`. |
| `tools/api-docs` | Private TypeDoc runner that writes the Markdown API reference into `docs/reference/typescript/`. |

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm -r typecheck && pnpm test && pnpm -r build
pnpm run api-docs
pnpm dev
```

Versions are pinned in `pnpm-workspace.yaml` catalogs with `catalogMode: strict`.
Biome formats and lints; Vitest runs every package as a project; Vite builds the
libraries after `tsc` emits declarations. See the repository
[development guide](../docs/development.md#typescript-workspace).

The orchestrator app consumes the ignored `../.dev/aiui` source link created by
`../scripts/link-aiui.sh`; install that checkout's dependencies separately.
Exact catalog entries plus source overrides keep library imports on the intended
checkout. Solid compiler/runtime pins move together. The real development-stack
test also needs root `.venv` with all Python packages/management extras installed.
See the [orchestrator guide](../docs/orchestrator.md) for isolation, source/HMR
qualification and current S0 limitations. Ordinary provider functionality has not
been added by this foundation.
