# Development

Run the commands on this page from the repository root. This is a workspace for
six distributions; the root is not itself a distribution. See [implementation status](implementation-status.md)
for supported package behavior and [testing](testing.md) for the evidence policy.

The imported `experiments/` tree is a separate research workspace, intentionally
excluded from the root uv workspace and Ruff hooks/checks. It retains its original
Python 3.14-only uv environment/lock and pnpm catalog/lock. Run research commands
from that directory, not the repository root. See [research and spikes](research.md)
for setup and the distinction between research checks and package CI.

The production [TypeScript workspace](#typescript-workspace) already holds
agent-history analysis. The [Codex client plan](plans/codex-client.md) is the
reviewed baseline for later client packages. HP browser/Node prototypes remain
in `experiments/`.

## Operating stance

For the orchestrator, client SDKs and reusable UI, begin each slice with the
[working method](plans/agent-orchestrator/methodology.md). It records when to ask
open product questions, how mocks can explore them, and the explicit-intent-first
rule. The [first-slice proposal](plans/agent-orchestrator/first-slices.md) is the
current sequential starting recommendation.
The [next mock rounds](plans/agent-orchestrator/next-mock-rounds.md) track the
later three-round sequence and review checkpoints. For any configuration UI,
begin with the existing ingestor/launcher/profile contract and document the
mapping from form choice to native field or operation.
The [runtime contracts and gotchas](runtime-contracts.md) are the shared memory
of consequential backend behavior. Review applicable RC entries, attach their
regression scenarios to the implementation plan, and update their evidence when
qualifying a new backend version.

Follow the [agreed design principles](design-principles.md). The default runtime
trusts the operator, agent, plugins and clients inside the operator's network.
Do not reintroduce mandatory authorization, 15-minute disconnects, restrictive
sandbox defaults or native-config secret classification while implementing the
proposals. Keep profile ownership, predictable paths, scoped process configuration
and cleanup tests: they prevent accidents, not trusted use. Monitor capture
backlog/storage rather than imposing initial payload limits or run quotas.
Lockdown is a separately designed later mode, not a prerequisite for development.

## Environment

For the working S0 browser/backend pair, follow the [orchestrator guide](orchestrator.md):
link/install the AIUI source checkout, install the root Python workspace with
management extras and the production TypeScript workspace, then run `pnpm dev`
from `typescript/`. It prints actual URLs and owns only that instance's resources.

Install uv and clone the repository, then run:

```sh
./scripts/setup.sh
```

The script runs `uv sync --frozen --all-packages --all-extras` and installs the pre-commit hook.
All packages and the root development tools share `.venv` and `uv.lock`.
The `.python-version` file selects Python 3.14. Package metadata allows Python 3.12+;
CI exercises 3.12, 3.13, and 3.14 using uv 0.12.17.

Use `uv lock --check` to check that the lockfile matches the manifests. A frozen
sync installs the existing lock without updating it; it is not a substitute for
that consistency check.

## Layout and conventions

- `packages/mitm/src/pdum/mitm/` contains `pdum.mitm`.
- `packages/codex-launcher/src/pdum/codex_launcher/` contains `pdum.codex_launcher`.
- `packages/hostfork/src/pdum/hostfork/` contains `pdum.hostfork`.
- `packages/claude-launcher/src/pdum/claude_launcher/` contains `pdum.claude_launcher`.
- Each package owns its manifest, README, and `tests/` directory.
- `pdum` is a PEP 420 namespace shared by the distributions. Do not add an
  `__init__.py` at the `src/pdum/` level. Keep each module's `py.typed` marker.
- Shared tool settings live in the root `pyproject.toml`. Follow Ruff's E/F/W/I
  rules, 120-character line length, and Python 3.12 syntax target.
- Use type annotations and NumPy-style docstrings for public interfaces.
- Keep the MITM package generic. Do not put Codex-specific behavior into it or
  keep the launcher's MITM integration optional rather than coupling core imports.
- Implement the CLIs with Typer and export mountable apps/app factories. CLI
  handlers delegate to library operations, not a second business-logic layer.
- Use Rich with Questionary terminal selectors for interviews; keep preview,
  planning, saving and login as separate steps. See [profile workflows](profiles.md).
- Keep recording/inspection/export off the forwarding path. Start with explicit
  processor hooks and small file/test implementations, not a plugin worker framework.

Keep live profiles outside the checkout. Raw captures and diagnostic output may
contain credentials and belong under ignored paths such as `artifacts/` or an
explicitly configured trusted sink. Optional simple masking is not a correctness
requirement for capturing data. Review/redact before public sharing or CI upload;
do not commit credentials or captures. Tests must not write to the developer's
normal Codex instance or install system-wide interception settings.

## Dependencies

Use `uv add --package DISTRIBUTION DEPENDENCY` for runtime dependencies, selecting
`habemus-papadum-mitm`, `habemus-papadum-codex-launcher` or
`habemus-papadum-hostfork` or `habemus-papadum-claude-launcher` as the consuming distribution.
Use `uv add --group dev TOOL` for
shared development tools. Optional launcher integrations use the `mitm` and
`management` extras; `federation` adds the HTTP token-exchange dependency.
Minimal launcher imports do not require these integrations.

If editing manifests directly, run `uv lock` deliberately, inspect the resulting
changes, and rerun `./scripts/setup.sh`. Include the root lockfile with dependency
changes. Do not create separate package environments or lockfiles. Future internal
dependencies use the root workspace source mappings.

## Checks and tests

```sh
uv lock --check
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pre-commit run --all-files
uv run --frozen --all-packages python -c "import pdum.mitm; import pdum.codex_launcher; import pdum.hostfork; import pdum.claude_launcher"
```

To apply formatting, use `uv run --frozen ruff format .`. The installed pre-commit
hooks can also fix formatting and lint findings; review their changes.

The import command checks packaging only. The suite exercises actual local
HTTP/TLS/WebSocket peers and child processes. Installed-Codex tests skip if the
binary is missing; they use unauthenticated isolated profiles, not paid inference.
See [testing](testing.md) for the opt-in Luna probe and USD 0.05–0.10 normal budget.

```sh
uv run --frozen --all-packages --all-extras pytest -m "not live"
uv run --frozen --all-packages --all-extras pytest packages/mitm/tests
uv run --frozen --all-packages --all-extras pytest packages/codex-launcher/tests
uv run --frozen --all-packages --all-extras pytest --cov --cov-report=xml --cov-report=term
```

Hostfork tests use real Linux namespaces/cgroups when available and visibly skip
capability-dependent cases elsewhere. The prepared Linux workflow requires those
capabilities and a disposable Btrfs pool. See [Hostfork validation](hostfork-validation.md).

Pytest discovers `test_*.py` files, `Test*` classes, and `test_*` functions. Shared
settings enable asyncio auto mode and disable output capture with `-s`.

## Documentation and distribution builds

```sh
uv run --frozen mkdocs serve
uv run --frozen mkdocs build --strict
uv build --all-packages
```

MkDocs uses Material, mkdocstrings, and NumPy-style docstring rendering. Site content
lives in `docs/`; navigation is in `mkdocs.yml`. Root and package READMEs serve GitHub
readers, and each package's README is also its distribution description.

The docs build writes to ignored `site/`. Hatchling builds source distributions and
wheels under ignored `dist/`. To build one package, use
`uv build --package habemus-papadum-mitm` or
`uv build --package habemus-papadum-codex-launcher`, or
`uv build --package habemus-papadum-hostfork`, or
`uv build --package habemus-papadum-claude-launcher`. Building does not publish anything.

## CI and Pages

The `CI` workflow runs on pushes to `main`, pull requests targeting `main`, and manual
dispatches. It checks lint, formatting, imports and tests with subprocess coverage
on Linux Python 3.12–3.14 and macOS Python 3.14. The Linux Python 3.14 job also builds
the docs and all distributions. Paid tests are excluded. No Codex binary is
installed by this workflow, so native interoperability tests skip there unless a
binary is provided. Build and coverage artifacts are not package releases.

A separate Claude client job installs native Claude 2.1.296, Node 26.10.0 and
pnpm 11.9.0 on Linux, builds the pinned official SDK example, and runs credential-free
concurrency and profile-isolation checks. It submits no model prompts and receives
no provider credentials. This newly prepared job has not yet run on GitHub.

The `Deploy documentation` workflow builds and deploys the MkDocs site to GitHub
Pages on pushes to `main`; it also has a manual trigger.
Deployment requires the repository's Pages source to be **GitHub Actions**, which
is already configured. Local edits are not published until pushed and deployed.

## Releases

[ship](https://github.com/habemus-papadum/pdum_ship) (`habemus-papadum-ship`)
releases this workspace's packages, one at a time, from the `release` workflow on
`main`. Agents do not dispatch it or publish packages; releases are the maintainer's.
No release is part of normal setup or checks.

Each package has its own version and its own tag series, `<package>-v<version>`,
for example `habemus-papadum-mitm-v0.1.0`. The tag is the truth: the next version is
the last tag plus the requested bump. Between releases a package's manifest carries
`<last release>+dev`; a package that has never released carries `0.0.0+dev` and no
tag, and its first minor release is `0.1.0`. Do not edit versions by hand.
`uv run ship deps check`, which CI and the `ship-check` pre-commit hook run, reports a
manifest that disagrees with its tag, a stale lockfile, a development link in
`[tool.uv.sources]` or an unexplained exact pin on a `habemus-papadum-*` package.
Dependencies between the packages here are floors (`habemus-papadum-mitm>=0.1.0`),
resolved from the workspace during development.

The workflow takes `package` (the distribution name), `bump` (`patch`, `minor` or
`major`), `dry_run` (default true), `skip_ci_check` and `skip_tests`. It calls the
reusable workflow in `habemus-papadum/pdum_ship`, which waits for the push-triggered
`ci.yml` run on the selected commit to succeed and then runs `ship release`: it writes
the release version into the package's `pyproject.toml` and `uv.lock`, builds the
package, runs `uv run --locked pytest -m 'not live'`, publishes to PyPI with the
`PYPI_API_TOKEN` repository secret, commits, tags and pushes commit and tag together,
creates the GitHub release, and writes `<version>+dev` back. A dry run plans and
prints without writing anything and needs no secret. The prepared Hostfork workflow
is not part of that gate; check it before releasing `habemus-papadum-hostfork`.

```sh
gh workflow run release.yml -f package=habemus-papadum-mitm -f bump=minor -f dry_run=true
uv run ship release habemus-papadum-mitm --bump minor --dry-run   # the same plan, locally
uv run ship changed                                               # packages with commits since their last tag
```

The release workflow pushes with `GITHUB_TOKEN`, whose pushes
[do not trigger other workflows](https://docs.github.com/en/actions/concepts/security/github_token),
so the release and back-to-development commits do not redeploy Pages or run CI.

`habemus-papadum-mitm`, `habemus-papadum-codex-launcher` and `habemus-papadum-hostfork`
were published as 0.1.0 on 2026-10-13 by the earlier lockstep workflow (tag `v0.1.0`);
the per-package baseline tags `<package>-v0.1.0` point at the same commit. The Claude
launcher, agent history and orchestrator packages have not been published. A failure
before publishing is reverted by `ship`; a failure after publishing is not, because
the registry already has the version, and `ship` prints the remaining commands
instead. Do not delete or reuse a published version to conceal a partial release.

## Claude client qualification

The [Claude launcher](claude.md) uses the official Python SDK for saved history,
with the official TypeScript SDK in browser/Node clients. Its optional `management`
extra includes the HTTP server; `mitm` composes the generic sidecar.
The small `examples/claude-client/` pnpm project has its own pinned dependencies
and is separate from both the root Python workspace and `experiments/`. Build it
with `pnpm install --frozen-lockfile` and `pnpm build` in that directory.
Live Haiku probes are explicit; record usage, SDK estimates and missing-result
uncertainty. See the [qualification report](claude-validation.md) for evidence
and gates, and the [checkpoint](claude-handoff.md) for prioritized follow-up work.
Ordinary CI never supplies provider credentials or submits prompts.

With native Claude and Node installed, run `uv run --frozen python
scripts/check_claude_clients.py --clients 4 --rounds 2 --timeout 120` from the
repository root. It checks the real official Node SDK against an isolated Python
manager and native worker, including repeated concurrent clients and cleanup.
Native profile tests additionally verify agents, skills, instructions, plugins
and MCP configuration with disposable local fixtures; they visibly skip when
the native binary, Node or installed example SDK is absent.

## TypeScript workspace

`typescript/` is a pnpm workspace (pnpm 11.9, Node 26 from `.nvmrc`) with its own
lockfile. It holds `@habemus-papadum/agent-history`, the query, invariant and
forensics side of [agent history](agent-history.md), and a private `tools/api-docs`
package that generates the Markdown API reference. Dependencies are pinned in
`pnpm-workspace.yaml` catalogs with `catalogMode: strict`.

```sh
cd typescript
pnpm install --frozen-lockfile
pnpm lint            # Biome check
pnpm -r typecheck
pnpm test            # Vitest across packages
pnpm -r build        # tsc declarations plus Vite library build
pnpm run api-docs    # TypeDoc Markdown into docs/reference/typescript/
pnpm -C packages/agent-history cli check ~/history/codex.duckdb
```

The schema contract flows one way: `uv run pdum-history schema --json` writes
`typescript/packages/agent-history/schema/agent-history.schema.json`, a Python test
compares the copy with the live contract, and CI diffs them. The generated
reference under `docs/reference/typescript/` is ignored by Git; run `pnpm run
api-docs` before a strict MkDocs build, as the docs workflow does.

### Local AIUI source and future browser apps

Create the optional development source link from the repository root:

```sh
./scripts/link-aiui.sh                         # sibling ../pdum_aiui
./scripts/link-aiui.sh ~/src/pdum_aiui          # explicit checkout
```

The ignored `.dev/aiui` symlink points at the actual checkout, including local
edits. It does not copy files, pull that checkout, install packages, or change
either workspace's lockfile. The script is idempotent and refuses to replace a
conflicting path. To remove this connection, unlink `.dev/aiui`; do not remove
its target directory.

This checkout is the definitive local framework reference. Read its `AGENTS.md`
before editing upstream and begin framework work with
`packages/aiui-viz/CATALOG.md`, `skills/aiui-architecture/SKILL.md` and the linked
package docs. The current source-first setup recipe is
`skills/source-first-workspaces/SKILL.md` and
`packages/aiui-build-config/docs/source-first-workspaces.md`, all under the link.
Git-backed plugin caches are independent snapshots and can lag local work.

The existing 041–052 prompt-related experiments already import actual
`aiui-prompts` source and selected inspector source. Their shared loader now
defaults to `.dev/aiui`; `AIUI_PROMPTS_CHECKOUT` can still override it with a
repository root. For example, from `experiments/`:

```sh
pnpm --filter @agent-spike/041-hp-codex-fidelity test
pnpm --filter @agent-spike/045-hp-behavior build
```

The S0 orchestrator app now declares actual AIUI dependencies through exact
catalog pins and source overrides. A filesystem link alone is not package
installation. Keep sibling workspaces/locks separate; CI checks out the qualified
AIUI revision explicitly. Source imports, a real UI hot edit and a shared-library
edit were checked in Chrome. Solid runtime and transitive compiler packages are
pinned together. See [the guide](orchestrator.md#source-linking-and-hmr) for the
explicit page remount boundary and remaining full-reload cases. Do not add global
pnpm links, blanket aliases or duplicate framework runtimes.

### Disposable orchestrator interaction studies

From `experiments/`, run `node spikes/055-orchestrator-mock-lab/serve.mjs` and open
the printed URL. It serves the overview and session/source/prompt studies with
synthetic data; each page links to a Markdown note describing its interaction
and unresolved choices. Separate preview launches have separate ports and
temporary runtime records. No credentials or model calls are involved.

See the [development-flow sketch](plans/agent-orchestrator/development-flow.md)
for the proposed browser/backend and Electron lanes and the isolation required
before live multi-agent development. The static mock host does not implement
those future service lifetimes or HMR. The [O22 entry](plans/agent-orchestrator/components/22-development-delivery.md)
keeps packaging questions open until they affect real implementation.

### Refreshing Codex and Git-backed plugins

Use the installed CLI's supported commands:

```sh
codex update
codex plugin marketplace upgrade
codex plugin list --json
codex plugin add aiui@fai-labs
```

The marketplace command refreshes catalogs; installing an already-installed
Git-backed plugin refreshes its own cached copy. Repeat the last command for the
installed plugins being refreshed. Preserve configured refs/SHAs and plugin
enablement choices; runtime-bundled and remote-directory plugins are separate.
Start a new Codex session to load refreshed skills; this does not hot-replace the
instructions of an already-running conversation. See the
[official plugin setup guidance](https://developers.openai.com/plugins/build/plugins).
CLI updates also leave `experiments/vendor/codex` at its deliberate research pin.
