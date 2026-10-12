# Testing and validation

Use real local processes and network peers for lifecycle/transport tests. Use
small live provider calls for claims about upstream authentication, models and
protocols. Mocked success responses do not establish compatibility.

## Ordinary tests: no paid calls

```sh
uv sync --frozen --all-packages --all-extras
uv run --frozen pytest -m "not live" --cov --cov-report=term-missing
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mkdocs build --strict
uv build --all-packages
```

The suite contains:

- Profile/copy/config and deterministic parser tests, including unknown native
  keys, credential-file snapshots, collisions and executable skill permissions.
- Real HTTP/TLS/WebSocket servers exercising the actual mitmproxy subprocess:
  streamed bodies, certificate verification, live capture toggles, complete binary
  messages, bad/slow processors, cancellation, process death and durable flush.
- Real WebSocket relay tests: browser Origin compatibility, separate clients,
  binary/text messages, a 17 MiB payload, observer failures and close propagation.
- Installed-Codex tests marked `codex`: native readiness, clean unauthenticated
  profiles, real remote TUI, native large-message fragmentation, competing launches,
  process cleanup and orphan recovery. These skip if `codex` is absent. They do
  not copy normal credentials or request inference.

Fixtures are appropriate for malformed parser input and process failure injection.
A deliberately sleeping local executable tests process ownership, not provider
behavior. ASGI tests exercise optional management routing; they are not evidence
of browser/TLS behavior or OpenAI interoperability.

Coverage includes Python subprocesses through coverage.py's subprocess patch.
Coverage percentage is a diagnostic, not a substitute for external-peer assertions
or live integration. Raw captures and credentials are never public CI artifacts.

CI is configured for Linux Python 3.12–3.14 and macOS Python 3.14. No Codex binary
is installed by CI, so its native-client tests run only where a binary is supplied.
The new matrix has not been exercised on GitHub until these changes are pushed.
Local macOS suites were also run on Python 3.12.11 and 3.13.5. The latter exposed
a real Homebrew Python re-exec: its startup wrapper changes process identity.
Lifecycle fixtures now select the stable interpreter executable; production orphan
recovery still refuses a process whose identity changed after it was journaled.

Built-wheel smoke tests use only declared runtime dependencies, verify core launcher
operation without MITM/FastAPI installed, then exercise an installed MITM worker
and managed sidecar/app-server. Restore the normal root uv development environment
after packaging checks; do not create package-local environments or lockfiles.

## Opt-in live CLI compatibility

From the repository root, with a usable installed Codex and file-backed ChatGPT
credentials:

```sh
uv run --frozen python scripts/validate_live_codex.py \
  artifacts/my-live-run --mitm --live
```

Use a new output directory each time. `--auth-file PATH` and `--binary PATH` select
explicit inputs. Omitting `--mitm` tests the client relay without upstream interception.
`--live` is required; ordinary pytest/PR CI never runs this script.

The probe copies authentication into disposable profile state, creates and names
a native Luna thread, and runs the **real Codex remote TUI** against the relay. It
requests one trivial answer, waits for the corresponding protocol turn completion,
then closes the client, Codex and proxy. It checks the effective model, original
credential-file hash, upstream WSS observations and token usage. The helper uses a
pseudoterminal, not a simulated app-server client. Captures stay under ignored
`artifacts/`; its printed summary contains no tokens or captured payloads.

Installed Codex 0.162.1 supports `codex --remote ENDPOINT` and remote `resume`, but
rejects remote `exec`. Its TUI also generates titles using a separate, hard-coded
`gpt-5.6-luna` thread when a thread has no name. An initial exploratory run exposed
that behavior and interrupted the main turn by closing the terminal too early.
The current probe pre-names the thread and gates shutdown on protocol completion;
it does not rewrite messages or substitute a model. Two subsequent checks used
only `gpt-6-luna` upstream and completed successfully.

Budget normally USD 0.05–0.10 per investigation. Up to USD 1 is authorized for an
important investigation, coordinated across agents. Keep prompts, turns, time and
retries bounded; inspect unexpected usage before continuing. Estimates are dated
API equivalents, **not subscription charges**. The current script conservatively
prices all observed Luna short-context input at the cache-write rate, including
observed warmup responses; it is not a general pricing/billing implementation.
Missing or interrupted usage remains uncertain rather than reported as zero.

See [implementation status](implementation-status.md) for the actual results and
remaining qualification gates. The wider specifications remain design targets.
