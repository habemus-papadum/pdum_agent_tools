# Development

Run the commands on this page from the repository root. This is a workspace for
two distributions, not a third root package. Package behavior will be specified
separately; this guide describes the development infrastructure that exists now.

The imported `experiments/` tree is a separate research workspace, intentionally
excluded from the root uv workspace and Ruff hooks/checks. It retains its original
Python 3.14-only uv environment/lock and pnpm catalog/lock. Run research commands
from that directory, not the repository root. See [research and spikes](research.md)
for setup and the distinction between research checks and package CI.

## Operating stance

Follow the [agreed design principles](design-principles.md). The default runtime
trusts the operator, agent, plugins and clients inside the operator's network.
Do not reintroduce mandatory authorization, 15-minute disconnects, restrictive
sandbox defaults or native-config secret classification while implementing the
proposals. Keep profile ownership, predictable paths, scoped process configuration
and cleanup tests: they prevent accidents, not trusted use. Monitor capture
backlog/storage rather than imposing initial payload limits or run quotas.
Lockdown is a separately designed later mode, not a prerequisite for development.

## Environment

Install uv and clone the repository, then run:

```sh
./scripts/setup.sh
```

The script runs `uv sync --frozen --all-packages` and installs the pre-commit hook.
Both packages and the root development tools share `.venv` and `uv.lock`.
The `.python-version` file selects Python 3.14. Package metadata allows Python 3.12+;
CI exercises 3.12, 3.13, and 3.14 using uv 0.12.17.

Use `uv lock --check` to check that the lockfile matches the manifests. A frozen
sync installs the existing lock without updating it; it is not a substitute for
that consistency check.

## Layout and conventions

- `packages/mitm/src/pdum/mitm/` contains `pdum.mitm`.
- `packages/codex-launcher/src/pdum/codex_launcher/` contains `pdum.codex_launcher`.
- Each package owns its manifest, README, and `tests/` directory.
- `pdum` is a PEP 420 namespace shared by the distributions. Do not add an
  `__init__.py` at the `src/pdum/` level. Keep each module's `py.typed` marker.
- Shared tool settings live in the root `pyproject.toml`. Follow Ruff's E/F/W/I
  rules, 120-character line length, and Python 3.12 syntax target.
- Use type annotations and NumPy-style docstrings for public interfaces once they exist.
- Keep the MITM package generic. Do not put Codex-specific behavior into it or
  add a dependency between the packages before their specifications require one.
- Implement both CLIs with Typer and export mountable apps/app factories. CLI
  handlers delegate to library operations, not a second business-logic layer.
- Keep recording/inspection/export off the forwarding path. Start with explicit
  processor hooks and small file/test implementations, not a plugin worker framework.

Keep live profiles outside the checkout. Raw captures and diagnostic output may
contain credentials and belong under ignored paths such as `artifacts/` or an
explicitly configured trusted sink. Optional simple masking is not a correctness
requirement for capturing data. Review/redact before public sharing or CI upload;
do not commit credentials or captures. Tests must not write to the developer's
normal Codex instance or install system-wide interception settings.

## Dependencies

Use `uv add --package habemus-papadum-mitm DEPENDENCY` or
`uv add --package habemus-papadum-codex-launcher DEPENDENCY` for runtime dependencies,
replacing `DEPENDENCY` with the required package. Use `uv add --group dev TOOL` for
shared development tools. No runtime dependencies are currently declared.

If editing manifests directly, run `uv lock` deliberately, inspect the resulting
changes, and rerun `./scripts/setup.sh`. Include the root lockfile with dependency
changes. Do not create separate package environments or lockfiles. Future internal
dependencies should use the root workspace source mappings.

## Checks and tests

```sh
uv lock --check
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pre-commit run --all-files
uv run --frozen --all-packages python -c "import pdum.mitm; import pdum.codex_launcher"
```

To apply formatting, use `uv run --frozen ruff format .`. The installed pre-commit
hooks can also fix formatting and lint findings; review their changes.

There are **no tests yet**. The import command checks packaging only, not runtime
behavior. Pytest currently exits with code 5 when nothing is collected, and CI
explicitly skips it until a package has a `tests/test_*.py` file. Add tests as behavior
is implemented, rather than adding a placeholder passing test.

Once tests exist:

```sh
uv run --frozen --all-packages pytest
uv run --frozen --all-packages pytest packages/mitm/tests
uv run --frozen --all-packages pytest packages/codex-launcher/tests
uv run --frozen --all-packages pytest --cov --cov-report=xml --cov-report=term
```

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
`uv build --package habemus-papadum-codex-launcher`. Building does not publish anything.

## CI and Pages

The `CI` workflow runs on pushes to `main`, pull requests targeting `main`, and manual
dispatches. It checks lint, formatting, and imports on Python 3.12–3.14, and runs
pytest with coverage when tests exist. The Python 3.14 job also builds the docs and
both distributions. Build and coverage artifacts are not package releases.

The `Deploy documentation` workflow builds and deploys the MkDocs site to GitHub
Pages on pushes to `main`; it also declares published-release and manual triggers.
Deployment requires the repository's Pages source to be **GitHub Actions**, which
is already configured. Local edits are not published until pushed and deployed.

## Releases

Releases are **human-operated** through the `release` workflow on `main`. Agents
must not dispatch it or publish packages. No release is part of normal setup or checks.

The two distributions share a version in lockstep. Between releases their manifests
carry the last release version plus `+dev`; the initial marker is `0.0.0+dev`.
Do not edit versions by hand or use built development artifacts as release artifacts.

The workflow accepts `bump` (`patch`, `minor`, or `major`), `skip_ci_check` (default
false), and `dry_run` (default true). It uses the highest `vX.Y.Z` tag as the last
release, or `0.0.0` when no tag exists. It requires a successful **push-triggered**
`ci.yml` run for the selected commit unless the maintainer explicitly overrides
the gate; a manual CI run does not satisfy that particular gate.

A dry run prepares the version changes on the runner but does not commit, tag, or
publish. A real release requires the `PYPI_API_TOKEN` repository secret, checks that
`main` still matches the selected commit, commits both versions and the lockfile,
tags and pushes, builds both distributions, publishes them to PyPI, creates a GitHub
release, and returns the manifests to the new version plus `+dev`.

There is no automatic publishing on ordinary pushes or tag events. Publishing and
the full release workflow have not been exercised for these packages. If a release
fails partway through, inspect its run, pushed tags, and registry state before any
retry; these steps are not a single atomic transaction. Do not delete or reuse a
published version to conceal a partial release.
