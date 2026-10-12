# Working in the imported research workspace

This directory is the imported `agent-spike` research workspace inside
`pdum_agent_tools`. Read [IMPORT.md](IMPORT.md) for provenance and exclusions.
Instructions below apply only to `experiments/`, not the production packages.

## Research-workspace exception

- Run research commands with `experiments/` as the working directory. In the
  inherited instructions below, "repository root" and "root workspace" mean this
  directory.
- Preserve this directory's pnpm catalog/lockfile and uv workspace/lockfile.
  Research Python uses its own `.venv` here, explicitly separate from the parent
  repository's production uv workspace. Do not merge experimental dependencies
  into production packages just to run an old spike.
- Native Codex source and build artifacts are not imported. Follow
  [vendor setup](vendor/README.md) before source-dependent probes; do not assume
  an old report's binaries, sessions or captures exist here.
- Existing reports record historical observations, not validation of these
  production packages or a promise that current installed tools behave identically.
- Root privacy and human-operated release restrictions still apply. Do not
  commit/push, publish packages or run credentialed probes unless the task calls
  for it. Run current network/model probes only with the bounds below.
- Preserve the imported evidence before extracting or redesigning code for the
  production libraries.

## Original research conventions

For new work, follow the parent repository's agreed
[trusted-operation principles](../docs/design-principles.md). Prioritize state and
process hygiene, easy credential reuse, and faithful capture inside the operator's
trusted network; do not add mandatory redaction or client lockdown by default.
Historical reports/code preserve their original behavior and are not retroactively
rewritten. Public summaries still omit secrets; raw captures stay out of Git.

This repository contains small experiments about controlling and observing agentic coding tools. Read [plans.md](plans.md) for the project motivation. [CLAUDE.md](CLAUDE.md) points to these same instructions.

## Organizing spikes

- Put each experiment in `spikes/NNN-short-name/`, with its own runnable entry point and package manifest where appropriate.
- Give each spike a concrete question, a bounded experiment, and an explicit result. Preserve uncertainty and distinguish documented behavior, source inspection, and behavior observed in a run.
- Write a roughly one-page summary in `docs/spikes/NNN-short-name.md`: question, main result, how to reproduce, versions and environment, evidence, limitations, and useful incidental findings. Link larger supporting notes or local artifacts when needed.
- Keep `docs/README.md` as the index of spike results. Store generated logs, captures, and build output under ignored paths such as `artifacts/`.
- Start with local code inside each spike. Extract shared logic into `packages/` or `python/` when several experiments reveal a useful common boundary.
- When working in parallel, assign ownership of spike folders and their documents. Coordinate edits to root configuration, dependency manifests, and lockfiles through the coordinating agent.

## Dependencies and execution

- Use pnpm workspaces for TypeScript and Node code. Reference external dependency versions through the root pnpm catalog and internal packages with `workspace:*`.
- Keep shared TypeScript settings in `tsconfig.base.json`. Use the existing Node and Python version pins.
- Use the root uv workspace and lockfile for Python. Add shared version constraints at the workspace root when multiple projects need the same dependency; do not create independent lockfiles or environments inside spikes.
- Record the actual SDK, executable, and source revision used in an experiment. Prefer an explicit workspace executable over whichever CLI happens to be on PATH.
- Keep experiments isolated from the developer's normal agent configuration and sessions. Do not modify their existing CLI configuration or credentials.
- Treat authentication material and raw API captures as local data. Redact secrets from summaries and terminal output; do not commit credentials or raw captures.
- Validate the concrete behavior under investigation with small, bounded probes. Document failures and environmental constraints rather than claiming untested functionality works.
- Prefer inexpensive live calls for protocol and integration findings; use `gpt-6-luna` for Codex probes unless the question requires another model. Do not substitute synthetic model responses merely to avoid a few cents of usage. Fixtures remain useful for deterministic regression and failure-injection tests, not as a replacement for live validation.
- Keep live probes bounded, inspect input/cached/output usage, and record a dated cost estimate separately from actual billing. Small experiments costing cents, up to roughly $0.50, are acceptable without additional confirmation; reassess before materially exceeding that scale. Do not silently fall back to a more expensive model.
