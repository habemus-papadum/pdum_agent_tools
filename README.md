# pdum_agent_tools

A Python workspace for two packages: a general-purpose man-in-the-middle (MITM)
sidecar and a Codex app-server profile manager and launcher.

**Status:** infrastructure scaffold with architecture proposals and implementation plans. Both packages
are empty. The descriptions below state intent, not implemented features.
There are no runtime APIs or command-line entry points yet.

## Packages

| Distribution | Python import | Intended scope |
| --- | --- | --- |
| [habemus-papadum-mitm](packages/mitm/README.md) | `pdum.mitm` | Launch a MITM sidecar and record traffic, with extension points to be specified. Not specific to AI agents. |
| [habemus-papadum-codex-launcher](packages/codex-launcher/README.md) | `pdum.codex_launcher` | Manage named Codex profiles and launch app-server with the selected model, parameters, upstream authentication, and executable. |

Neither package currently has runtime dependencies or depends on the other.

## Operating stance

Designed for one advanced operator who trusts the agents and controls the network.
Defaults are sandbox off, approval prompts off, and TCP listeners on all interfaces,
without mandatory client grants or connection-expiry timers. Focus on avoiding
accidental state/path collisions and preserving useful captures, not internal
security enforcement. Native Codex configuration stays native; credential reuse
should be easy. A separate lockdown mode can come later.

Launch is foreground/application-owned, with PID-aware cleanup; no daemon is needed.
MITM is off by default. Optional inspection copies traffic into asynchronous
processors without gating forwarding. Start with full captures, monitoring rather
than size quotas, simple extension hooks, and reusable Typer CLI apps.

See the agreed [design principles](docs/design-principles.md), including the
distinction between trusted runtime data and what may be published to this public
repository. These are design decisions, not implemented functionality.

The related [research workspace](experiments/README.md) imports the agent-spike
experiments and remains available for new spikes. Its source, reports, protocol
guide, and dependency locks are kept separate from the two package distributions.
See [import provenance and exclusions](experiments/IMPORT.md).

## Architecture and implementation proposals

- [Architecture overview](docs/architecture.md): package boundaries, requirements,
  and cross-package invariants.
- [Design principles](docs/design-principles.md): agreed trust model, defaults,
  configuration philosophy, and hygiene priorities.
- [Codex launcher](docs/specs/codex-launcher.md): profiles, authentication, async
  launch lifecycle, optional relaying, and MITM integration.
- [MITM sidecar](docs/specs/mitm.md): generic proxy lifecycle, recording, extensions,
  and runtime capture controls.
- [Implementation sequence](docs/plans/implementation.md): joint delivery gates,
  with detailed [launcher](docs/plans/codex-launcher.md) and
  [MITM](docs/plans/mitm.md) plans.

These are proposals for review, including recommended interfaces and defaults,
not finalized contracts or claims of implemented behavior. Compatibility gates
and deferred capabilities are marked explicitly.

## Development

Use [uv](https://docs.astral.sh/uv/) from the repository root. The development
interpreter is Python 3.14; package metadata supports Python 3.12+, with CI checking
3.12, 3.13, and 3.14. CI currently uses uv 0.12.17.

```sh
git clone https://github.com/habemus-papadum/pdum_agent_tools.git
cd pdum_agent_tools
./scripts/setup.sh
```

Setup installs both workspace members and development tools from `uv.lock`, then
installs the pre-commit hook. Common checks:

```sh
uv lock --check
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pre-commit run --all-files
uv run --frozen mkdocs build --strict
uv build --all-packages
```

See the [development guide](docs/development.md) for dependency changes, testing,
documentation, builds, CI, and the human-operated release process. There are no
tests yet; CI verifies imports and skips pytest until tests are added.

## Repository layout

```text
packages/mitm/             habemus-papadum-mitm
packages/codex-launcher/   habemus-papadum-codex-launcher
experiments/              Independent pnpm/uv research workspace and spike reports
docs/                     MkDocs source
scripts/setup.sh          Local environment and hook setup
.github/workflows/        CI, Pages, and manual releases
pyproject.toml            Workspace and shared development configuration
uv.lock                   Shared dependency lockfile
```

Each package uses `src/pdum/<module>/` and has its own `tests/` directory. `pdum`
is a shared namespace package, not a separately installed distribution.
Research commands run from `experiments/` using its own locks; they are not part
of `uv build --all-packages` at the repository root.

## Working conventions

- Keep each package's scope explicit; agree on its specification before adding behavior.
- Keep dependencies and the virtual environment in the shared uv workspace.
- Keep credentials, authentication profiles, traffic captures, and generated output out of Git.
- Use [AGENTS.md](AGENTS.md) as the canonical agent instructions;
  [CLAUDE.md](CLAUDE.md) points to the same guidance.

The [documentation site](https://habemus-papadum.github.io/pdum_agent_tools/) is
published through GitHub Pages. The architecture proposals will be reviewed before
implementation; usage examples will follow working interfaces.
