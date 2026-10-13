# Agent spike — imported research workspace

This is the research tree imported into `pdum_agent_tools/experiments/`, not the
production packages. Start with [import notes](IMPORT.md), including provenance,
missing artifacts and the independent research workspace setup. Run commands on
this page from `experiments/`. Historical result documents retain their original
observations and do not claim fresh validation after the import.

A small monorepo for experiments in controlling Claude Code and Codex CLI remotely.
The initial scaffold provides runnable entry points; CLI integrations can be added
as individual experiments.

Project goals are recorded in [plans.md](plans.md). See [spike results](docs/README.md)
for the experiments and [AGENTS.md](AGENTS.md) for working conventions shared with
Claude Code through [CLAUDE.md](CLAUDE.md).

For launching a service with the right OpenAI credentials, start with the
[upstream authentication tutorial](docs/tutorials/codex-upstream-auth.md).

## Layout

```text
apps/
  cli/                    Node + TypeScript experiment entry point
  web/                    Vite + vanilla TypeScript information pages
packages/
  experiment-kit/         Shared TypeScript types and experiment catalog
python/
  experiments/            Python 3.14 experiment package
spikes/
  NNN-short-name/          Runnable, focused experiments
docs/
  spikes/                 One-page findings for each experiment
  tutorials/              Practical integration walkthroughs
vendor/
  codex/                  Optional local Codex checkout (not included)
```

The JavaScript packages use a [pnpm workspace](https://pnpm.io/workspaces).
Python packages use a [uv workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/)
with a shared environment and lockfile. The web app uses [Vite](https://vite.dev/guide/).
External JavaScript versions are pinned in the root pnpm catalog, including the
SDKs and build tools. Package manifests use `catalog:` references. Python members
share the root uv resolver and lockfile; shared dependency constraints belong in
the root `pyproject.toml` when needed.

## Setup

Use Node 26, pnpm 11.9.0, and uv. Python is pinned to the 3.14 release series.

```sh
pnpm install
uv sync --all-packages
```

For source-dependent experiments, follow [vendor setup](vendor/README.md) to fetch
the pinned Codex fork. The imported workspace has no Git submodule or bundled
native executable. Build the clean baseline before applying the optional Spike 013
patch.

The individual [spike summaries](docs/README.md) contain their run and build commands.

For Hostfork research, start with the [runtime/shell quickstart](spikes/020-hostfork-runtime/README.md)
and [architecture findings](../docs/specs/hostfork/spike-findings.md). Spikes 020–024
test prepared Btrfs storage, host services, concurrency, deadlines and failure
evidence using local Linux facilities. They need only this workspace's uv setup.

Both lockfiles are committed. For reproducible installs, use
`pnpm install --frozen-lockfile` and `uv sync --all-packages --locked`.

## Run

```sh
pnpm dev:cli
pnpm dev:web
pnpm dev:python
```

`dev:cli` lists the planned experiments. `dev:web` starts the Codex app-server
architecture guide at the local URL printed by Vite, with a five-minute overview
and searchable protocol inventory. `dev:python` runs the Python starter.
The TypeScript entry points build the shared package before starting;
after editing that package, restart the command or run its build again.

The raw-protocol investigations are available as `pnpm spike:004` (MITM traffic),
`pnpm spike:005` (auth profiles and storage), and `pnpm spike:006` (sandbox and
permission scope). Read [their summaries](docs/README.md) for executable choices,
fixture/live distinctions, and limitations. These are experiments, not yet the toolkit.

`pnpm spike:008` makes one live `gpt-6-luna` turn through MITM, verifies WebSocket
capture, and estimates cost from observed usage. See [Luna findings and MITM design](docs/spikes/008-luna-websocket.md).

`pnpm spike:006:config` checks runtime configuration scope without model calls.
`pnpm spike:009` measures live turn telemetry and model overrides; `pnpm spike:010`
tests live Sol-driven subagents (add `--luna` to request Luna children).
`pnpm spike:011` checks actual Codex WASM compilation and a small host-WebSocket
binding. Consult the [spike summaries](docs/README.md) for prerequisites and limits.

`pnpm spike:012` reproduces the CLI's context meter from saved live usage events,
without another model call. [Spike 012](docs/spikes/012-codex-context-meter.md)
explains the meter's baseline, rounding, and source of context-window metadata.

[Spike 013](docs/spikes/013-codex-browser-origin.md) adds an opt-in browser Origin
allowlist to the pinned app-server source. Its separate native binary and two-page
browser probe leave the installed Codex executable unchanged.

## Check and build

```sh
pnpm typecheck
pnpm build
pnpm --filter @agent-spike/cli start
uv run --package agent-spike-python agent-spike-python
```

## Add experiments

- Start each experiment under `spikes/NNN-short-name/`, with a runnable entry point
  and a summary in `docs/spikes/`. Keep Python spike members under the spike's
  `python/` directory, using the root uv workspace and lockfile.
- Use `apps/` for reusable application surfaces. Extract shared TypeScript into
  `packages/` and shared Python into `python/` only when a common boundary emerges.
  Use `workspace:*` for internal TypeScript dependencies and catalogs for external ones.
- Keep generated output under ignored `artifacts/`. Keep authentication profiles
  outside the checkout; never commit credentials or raw captures.
