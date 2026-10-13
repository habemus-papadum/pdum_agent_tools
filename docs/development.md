# Development

Run the commands on this page from the repository root. This is a workspace for
four distributions; the root is not itself a distribution. See [implementation status](implementation-status.md)
for supported package behavior and [testing](testing.md) for the evidence policy.

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

The `Deploy documentation` workflow builds and deploys the MkDocs site to GitHub
Pages on pushes to `main`; it also declares published-release and manual triggers.
Deployment requires the repository's Pages source to be **GitHub Actions**, which
is already configured. Local edits are not published until pushed and deployed.

## Releases

Releases are **human-operated** through the `release` workflow on `main`. Agents
must not dispatch it or publish packages. No release is part of normal setup or checks.

The four distributions share a version in lockstep. Between releases their manifests
carry the last release version plus `+dev`; the initial marker is `0.0.0+dev`.
Do not edit versions by hand or use built development artifacts as release artifacts.

The workflow accepts `bump` (`patch`, `minor`, or `major`), `skip_ci_check` (default
false), and `dry_run` (default true). It uses the highest `vX.Y.Z` tag as the last
release, or `0.0.0` when no tag exists. It requires successful **push-triggered**
`ci.yml` and `hostfork.yml` runs for the selected commit unless the maintainer explicitly overrides
the gate; a manual CI run does not satisfy that particular gate.
The prepared Hostfork workflow runs on every push to `main`, including documentation
changes, so both gates can qualify the same release commit. Pull requests retain
path filtering for the prepared workflow.

A dry run prepares the version changes and builds all four distributions on the
runner but does not commit, tag, or publish. A real release requires the
`PYPI_API_TOKEN` repository secret, builds before creating public refs, checks that
`main` still matches the selected commit, commits all versions and the lockfile,
tags and pushes, publishes the prepared distributions to PyPI, creates a GitHub
release, and returns the manifests to the new version plus `+dev`.

For a first release, configure the publishing credential, select `main` in the
workflow UI, and run with `dry_run=true`. After reviewing the planned version and
successful builds, the maintainer can run the same bump with `dry_run=false` and
leave `skip_ci_check=false`. The default minor bump starts at `0.1.0` when there
are no release tags. Development wheels containing `+dev` are not the artifacts
to upload.

The release workflow uses `GITHUB_TOKEN` for its Git pushes and GitHub release.
Those events [do not trigger other workflows](https://docs.github.com/en/actions/concepts/security/github_token),
so its release event does not automatically redeploy Pages or run CI on the
version-only commits. Source documentation is deployed by the preceding human
push; use a manual documentation deployment if a release-specific refresh is needed.

There is no automatic publishing on ordinary pushes or tag events. The original three packages were published successfully as v0.1.0 on 2026-10-13.
The new Claude launcher has not been published yet; it joins the lockstep workflow
for a future maintainer-operated release. If a release
fails partway through, inspect its run, pushed tags, and registry state before any
retry; these steps are not a single atomic transaction. In particular, a failure
after the tag is pushed can leave manifests at the release version, so a blind
rerun fails the normal `+dev` baseline check. If upload was partial, recover the
original release artifacts and publish only the missing files, verify every published
project and the GitHub release, then restore the lockstep development versions
with `uv version` and `uv lock`. Release artifacts are uploaded before PyPI
publication; a build or earlier upload failure has no PyPI artifacts to recover.
Do not delete or reuse a published version to conceal a partial release.

## Claude client qualification

The [Claude launcher](claude.md) uses the official Python SDK for saved history,
with the official TypeScript SDK in browser/Node clients. Its optional `management`
extra includes the HTTP server; `mitm` composes the generic sidecar.
The small `examples/claude-client/` pnpm project has its own pinned dependencies
and is separate from both the root Python workspace and `experiments/`. Build it
with `pnpm install --frozen-lockfile` and `pnpm build` in that directory.
Live Haiku probes are explicit; record usage, SDK estimates and missing-result
uncertainty. See the [qualification report](claude-validation.md) for evidence
and gates. Ordinary CI never supplies provider credentials or submits prompts.
