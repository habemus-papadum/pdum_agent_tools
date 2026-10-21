# TypeScript workspace

The production pnpm workspace of pdum_agent_tools. It is independent of the Python
uv workspace at the repository root, of the `experiments/` research workspace and
of `examples/`; ordinary Python installation never needs it.

| Package | Role |
| --- | --- |
| [`packages/agent-history`](packages/agent-history/README.md) | `@habemus-papadum/agent-history`: invariant checks, the analysis question set, a session list and a terminal renderer over DuckDB files written by the Python `pdum-history` ingesters. |
| `tools/api-docs` | Private TypeDoc runner that writes the Markdown API reference into `docs/reference/typescript/`. |

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm -r typecheck && pnpm test && pnpm -r build
pnpm run api-docs
```

Versions are pinned in `pnpm-workspace.yaml` catalogs with `catalogMode: strict`.
Biome formats and lints; Vitest runs every package as a project; Vite builds the
libraries after `tsc` emits declarations. See the repository
[development guide](../docs/development.md#typescript-workspace).

For upcoming browser apps, `../scripts/link-aiui.sh` exposes the sibling AIUI
checkout through the ignored `../.dev/aiui` source link. There is no production
AIUI dependency yet; see [local AIUI development](../docs/development.md#local-aiui-source-and-future-browser-apps)
before adding package links to a consuming app.
