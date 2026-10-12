# Research import

**Imported:** 2026-10-12 from `/Users/nehal/src/agent-spike`. This is a source
snapshot, not a merge of its Git history and not new validation of its findings.

## Provenance

- Source repository: `https://github.com/habemus-papadum/agent-spike.git`.
- Source checkout HEAD: `1c33f1de5b7bab53c89d00b430d11bc6f5b03a3d`.
- Included **127 eligible source files**, approximately 1.12 MB, as present in the
  working tree: tracked files, tracked modifications and untracked unignored
  research files. HEAD alone does **not** reproduce this snapshot because most
  later spikes/documents were still uncommitted.
- Native Codex source pin:
  `6c372fbef45f730b6d8aa727b0ec8332365588db` from
  `https://github.com/habemus-papadum/codex.git`. Only its pin and the existing
  Spike 013 source patch are preserved, not the vendor checkout.
- The original repository and its worktree were left unchanged.

The import preserves relative paths: spikes can still refer to shared research
code, docs, the web guide, lockfiles and local artifact paths. Source package names
and tool versions are unchanged. Four imported files have relocation notes rather
than byte-identical contents: `AGENTS.md`, `README.md`, `.gitignore`, and
`spikes/013-codex-browser-origin/README.md`. This note and `vendor/README.md` are
new. There were no executable source files or symlinks requiring mode restoration.

## What is included

- Spikes 001–013 and their runnable sources, manifests, tests and historical
  summaries; the upstream-auth tutorial and original project narration.
- Shared TypeScript/Python experiment starters and the Vite protocol guide.
- Original pnpm workspace, catalogs and lockfile; independent research uv
  workspace/lockfile and Node/Python pins.
- The generated `apps/web/public/protocol-inventory.json`: a static protocol
  schema/inventory used by the guide, **not** an API session or traffic capture.
- Spike 013's `browser-origin.patch`, without modifying installed Codex.

## What is deliberately absent

No source `.git`, source `.gitmodules`, vendor gitlink/checkout, `node_modules`,
`.venv`, native builds, `dist`, caches, ignored artifacts, credentials, auth
profiles, interception CA/private keys, raw API captures or saved sessions were
copied. The optional vendor checkout is ignored here. Follow its
[setup instructions](vendor/README.md) when needed.

Old documents mention `artifacts/...`, absolute development paths, local
executables and earlier browser results. Those are **historical references**;
the underlying captures/builds were intentionally not migrated. Reports that
say “this checkout” or “the patch is applied” refer to the original experiment
unless an import note says otherwise. No probe has been rerun by the import.

A format-based scan found no PEM private keys, recognizable GitHub/OpenAI/AWS
access keys, JWTs or long literal bearer values in eligible sources. That check
does not prove arbitrary prose contains no private information; inspect changes
again before publication. Raw captures remain local to the original checkout.

## Independent workspace setup

From the parent repository:

```sh
cd experiments
pnpm install --frozen-lockfile
uv sync --all-packages --locked
```

Use the local pins: Node 26, pnpm 11.9.0 and Python 3.14. These install commands
may fetch dependencies and run normal dependency build hooks; they do not run
model probes. The production packages use the parent uv workspace; this research
directory intentionally keeps its original independent environment and lockfile.
Do not run research commands through the production environment by accident.

Non-model checks and the guide:

```sh
pnpm typecheck
pnpm build
pnpm dev:web
```

Source-dependent generation/build commands need the optional vendor setup; some
analysis commands also need ignored captures that are absent. Existing unit tests
can use deterministic fixtures, but those are not new evidence of upstream model
behavior. Read each spike's prerequisites before running it.

Several `pnpm spike:NNN` commands make **live paid/subscription model calls**, may
read credentials through an explicitly selected isolated auth mode, launch
subprocesses, or perform substantial native compilation. Do not batch-run them as
an import check. The inherited [agent instructions](AGENTS.md) require inexpensive
bounded probes, observed usage and dated cost estimates; do not silently replace
an unavailable model with a more expensive one.

## Relationship to production work

This tree is research evidence and executable experiments, not production APIs.
Use the parent architecture proposals and implementation plans to decide what to
extract into `packages/mitm` or `packages/codex-launcher`. Do not add production
dependencies on private spike internals or treat an old successful report as
validation of newly written library code.

## Validation after relocation

The coordinating agent checked the imported workspace on 2026-10-12:

- `pnpm install --frozen-lockfile --offline` used cached dependencies successfully.
- `pnpm typecheck` and `pnpm build` passed, including the Vite guide build.
- `pnpm -r test` passed 12 existing deterministic tests; one capture-replay test
  was skipped because its private historical capture was deliberately not imported.
- `uv lock --check` and `uv sync --frozen --all-packages` passed in this independent
  workspace. Neither research lockfile changed.

These checks did not fetch/build Codex, run model calls, reproduce browser probes,
or revalidate the historical provider findings. Generated dependencies and build
output stay ignored and are not part of the source import.
