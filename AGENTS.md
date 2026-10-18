# Working in pdum_agent_tools

These are the canonical instructions for agents working in this repository.
[CLAUDE.md](CLAUDE.md) points here so Claude Code and other agents follow the same
conventions. Read the [README](README.md) and [development guide](docs/development.md)
for the project layout and commands.

## Scope and design

- The workspace contains `habemus-papadum-mitm` (`pdum.mitm`),
  `habemus-papadum-codex-launcher` (`pdum.codex_launcher`),
  `habemus-papadum-hostfork` (`pdum.hostfork`), and
  `habemus-papadum-claude-launcher` (`pdum.claude_launcher`).
- Implementation of the agreed architecture is authorized. Use `docs/specs/` and
  `docs/plans/` as the design baseline; record supported behavior and remaining
  gates honestly rather than claiming the whole proposal is implemented.
- Keep MITM functionality independent of AI agents and Codex-specific concerns.
- Claude live clients are the official browser and Node SDKs. The Python launcher
  owns profiles/processes and relays bytes; it never owns a second conversation
  query. Multiple workers may share one Claude profile. Disconnect ends its worker.
  Use official SDK history helpers; do not reverse-engineer native recovery internals.
  API keys, explicit existing-login reuse and native dedicated-profile login are
  the first authentication strategies. Qualify login early with operator help.
- Distinguish intended functionality from implemented and tested behavior in documentation.
- Follow the agreed [trusted-operation principles](docs/design-principles.md): one
  advanced operator, trusted agents/clients inside an operator-controlled network.
  Default to sandbox off, approval prompts off, and all-interface TCP listeners.
  Do not add mandatory client grants, connection expiry, secret classification,
  or other lockdown machinery to the default path. Lockdown is a later opt-in mode.
- Prioritize hygiene: prevent accidental profile/path collisions, source writes
  and wrong-process cleanup. Keep native Codex config native,
  including unknown fields; avoid a second configuration schema or policy engine.
- A Codex profile directory is a Codex home; launcher state lives in its `.pdum/`
  subdirectory, and `--default` selects the user's own home with environment
  isolation off. Codex coordinates concurrent processes per home natively, so
  record launcher runs and inspect homes instead of holding an exclusive lease.
  Launch never edits native config: launch-time choices are `-c` overrides.
  Explicit edit commands may change any profile's `config.toml`, the default included.
- Make temporary profiles and credential reuse convenient, with concise warnings
  instead of repeated consent gates. Trusted runtime captures may include secrets;
  simple optional masking is fine, comprehensive redaction is not a prerequisite.
- Keep launch application-owned/foreground, with PID-aware status and cleanup;
  no launcher daemon. Attaching a client to a server the launcher did not start is
  a testing affordance, never the default. MITM is absent unless requested. Hostfork explicitly supports detached environments and reopening
  management by recorded identity; it does not restore previous asyncio pipe handles.
- Keep observation inspection-only and asynchronous: copying/enqueueing must not
  wait for parsing, recording or export. Monitor capture backlog/storage; do not
  introduce initial payload caps, truncation thresholds, queue-admission limits
  or run quotas. Report real loss/failures; future guardrails need separate review.
- Build simple explicit processor hooks and local/test implementations first.
  Optional discovery/CLI extensions do not require per-plugin worker processes.
  Keep Codex interpretation in the launcher or an adjacent integration package.
- Use Typer for the CLIs, exporting mountable apps and app factories. CLI wrappers
  call the async library; mounting/importing must not launch processes or install
  signal handlers. FastAPI may adapt management operations without owning a second runtime.
- Use Rich for interactive presentation and Questionary's compatible terminal
  selectors for interviews. Keep the interview separate from persistence/login;
  previews and cancellation must not mutate profiles.
- Keep changes focused. Do not introduce shared abstractions or cross-package
  dependencies merely because packages live in this repository.
- `experiments/` contains the imported agent-spike research workspace and future
  spikes. Read its own `AGENTS.md` before editing it. Research findings are not
  automatically implementation contracts for the distributable packages.
- `experiments/evals/` is the agent eval battery: one bounded task given to Codex,
  Claude Code or an agent of our own, measured from the shared agent-history schema
  and compared with recorded baselines. Its `README.md` is the runbook; raw run data
  stays under `~/history/evals/`, never in git.

## Python and dependencies

- Use uv exclusively, with the root `pyproject.toml`, `uv.lock`, and `.venv`.
  Do not create package-local lockfiles or virtual environments.
- Exception: the self-contained `experiments/` research workspace retains its own
  uv workspace/lock/environment and pnpm workspace/catalog/lock. Run its commands
  from `experiments/`; do not merge its Python 3.14-only dependencies or TypeScript
  tooling into the distributable packages. Root Ruff checks exclude that tree.
- Run development commands from the repository root. Bootstrap with `./scripts/setup.sh`.
- Respect the Python 3.14 development pin and Python 3.12+ package compatibility.
- Add runtime dependencies to the consuming package; put shared development tools
  in the root `dev` dependency group. Use workspace sources for internal dependencies.
- Keep the lockfile consistent with manifest changes. Use `uv lock --check` to
  validate it and `uv sync --frozen --all-packages` for reproducible installation.
- Use the `src/pdum/<module>/` layout. `pdum` is a PEP 420 namespace: never add
  `src/pdum/__init__.py`. Each distribution has its own module and `py.typed` marker.

## TypeScript workspace

- `typescript/` is the production pnpm workspace (pnpm 11, Node 26, Biome, Vitest,
  Vite). Run its commands from `typescript/`; it has its own lockfile and never
  shares dependencies with `experiments/` or `examples/`. Ordinary Python
  installation must not require Node.
- Every dependency version lives in `typescript/pnpm-workspace.yaml` catalogs
  (`catalogMode: strict`); manifests say `"catalog:"`. Pin exact versions and
  add a pin before adding a dependency.
- The agent-history schema is a contract owned by the Python package: regenerate
  `typescript/packages/agent-history/schema/agent-history.schema.json` with
  `uv run pdum-history schema --json` whenever `pdum.agent_history.schema` changes
  and bump `SCHEMA_VERSION`. A Python test and CI compare the two copies.
- Query, invariant and forensics code belongs in TypeScript so it can run in Node,
  a browser or against MotherDuck; readers of local agent storage belong in Python
  beside the launchers. Keep that split rather than duplicating either side.
- Support roughly six months of session history. Count older storage formats in
  `coverage` instead of adapting to them, add an invariant check rather than a
  compatibility shim, and treat a failing check as a planning item.

## Quality and documentation

- Follow the shared Ruff configuration: 120-character lines, Python 3.12 target,
  and E/F/W/I lint rules. Use type annotations and NumPy-style public docstrings.
- Add tests alongside implemented behavior under each package's `tests/` directory,
  using `test_*.py`, `Test*`, and `test_*` names. Do not add fake tests to conceal an empty suite.
- Validate relevant behavior and run lint, formatting checks, strict MkDocs builds,
  and package builds when affected. Do not claim that absent tests have passed.
- Keep repository/package READMEs and the development guide consistent. Update
  the canonical guidance here rather than duplicating it in `CLAUDE.md`.
- Prefer real local subprocess/network integration tests and small live provider
  probes over mocked successful API responses. Fixtures are useful for parser
  regressions and injected failures, not proof of upstream compatibility.
- Use `gpt-6-luna` for paid Codex checks, without silently substituting models.
  Aim for USD 0.05–0.10 per investigation; up to USD 1 is authorized for important
  validation. Coordinate spend across agents, bound turns/time/retries and record
  usage plus dated estimates separately from actual subscription billing.
- Use Haiku for small Claude compatibility checks, with explicit experiment
  turn/spend bounds and a usage ledger. Runtime defaults do not inherit probe quotas.
- The interoperability milestone is the real vanilla Codex remote CLI connecting
  through our relay to app-server unchanged, including a small live turn. Check
  actual CLI support instead of assuming `codex exec` accepts a remote endpoint.

## State hygiene and publication

- Never commit credentials, tokens, private keys, authentication profiles, or raw
  traffic captures. Ignored `artifacts/` is for local generated output, not published evidence.
- Use isolated temporary state for tests. Do not modify the developer's ordinary
  Codex home, configuration, credentials, or sessions.
- Avoid unnecessary credential/environment dumps in ordinary status/errors. Local
  captures and explicitly configured internal sinks may retain sensitive payloads;
  do not prohibit this or build a secret-classification framework around it.
- Keep secret values out of published documentation and CI artifacts. Do not
  install a global interception CA or change system proxy settings without a request.

## Git and releases

- Do not commit, push, or create branches unless asked.
- Do not hand-edit package versions. All distributions follow the lockstep
  version managed by the human-operated release workflow.
- Do not dispatch the release workflow, publish packages, or create/rewrite release
  tags. Explain the process when asked; leave release execution to the maintainer.
- Do not add automatic publishing on push or tag events. Release secrets belong
  in GitHub configuration, never in this repository.
