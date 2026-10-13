# Claude launcher qualification

**2026-10-13.** This report describes the new Python launcher, separately from the
earlier TypeScript spikes. No release of the new package has been published.

## Verified behavior

- Real native Claude initialization without credentials, with isolated state.
- Concurrent independent workers sharing a profile; closing/stopping one leaves
  another usable. Allocation alone starts no process.
- Exact relay payloads across partial UTF-8/NDJSON boundaries, including messages
  above the usual WebSocket default size limit; duplicate controller refusal,
  cancellation and ordinary manager shutdown.
- Real process cleanup, including a TERM-resistant child/process-group fixture;
  failures remain visible. Escaped/reparented descendants are not generally recovered.
- Python SDK history operations in separate fixed-environment helpers. Two profiles
  sharing a workspace and conversation ID remain separate; rename/read/fork preserve
  the intended source, and large responses are complete. Cancellation reaps helpers.
- Native auth status for fresh isolated profiles reports no login. Explicit default
  macOS Keychain reuse reports OAuth-token authentication without persisting the token.
- Dedicated-profile native login completed by the operator. A subsequent status
  check reported `claude.ai` authentication, and one live Node SDK Haiku turn
  succeeded using that profile's native login. The client hook ran, two saved
  messages were readable, and the worker exited with code 0 and no cleanup errors.
  This checks initial login and use; credential refresh has not been qualified.
- Official Node SDK initialization, interrupt, a client-owned prompt hook, one live
  Haiku result, disconnect cleanup and two saved messages read by the Python SDK.
- A four-turn live Node flow with concurrent workers in one profile, independent
  disconnect, rename/fork without changing source history, and profile isolation.
  Both the fork and an explicit resume recalled the original marker. All four
  native workers exited cleanly; the probe passed on its first attempt.
- Optional MITM composition captured an actual upstream `/v1/messages` response:
  HTTP 200, `text/event-stream`, four response chunks and a complete archive.
  Worker and proxy stopped normally; no global proxy or trust settings changed.
- CLI import/mount safety, invalid-selection errors and canceled profile interviews
  without writes/login. Native settings copies preserve source bytes.

Python SDK **0.2.165**, TypeScript SDK **0.3.296**, native Claude **2.1.296**,
Python **3.14.7**, macOS arm64 were used. Browser/Node examples pin their own npm
dependencies separately from the Python package.

## Cost ledger

| Probe | Model | Requests | SDK estimate, USD |
| --- | --- | ---: | ---: |
| Official Node SDK through Python manager | Haiku 5.5 | 1 | 0.0000548 |
| Official Node SDK through manager and MITM | Haiku 5.5 | 1 | 0.0000550 |
| Concurrent Node conversations, fork and resume | Haiku 5.5 | 4 | 0.00030749 |
| Dedicated-profile native login through Node SDK | Haiku 5.5 | 1 | 0.0001303 |
| **Total** | | **7** | **0.00054759** |

The direct turn reported 453 input and 19 output tokens; the MITM turn reported
455 input and 19 output tokens, both without cache usage. The four-turn flow used
912 uncached input tokens, 160 output tokens, 649 cache-write tokens with a one-hour
TTL, and 649 cache-read tokens. Its incremental estimates were $0.0000469,
$0.0001019, $0.0001410 and $0.00001769. Resume reports cumulative conversation cost,
so the previously observed cost was subtracted rather than counted twice.
The dedicated-login turn reported two uncached input tokens, 603 one-hour
cache-write tokens and 19 output tokens, with no cache reads.

Independent pricing of the public usage fields agreed with the SDK cost deltas,
using [Haiku 5.5 pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
checked on 2026-10-13 for prompts up to 100,000 tokens: per million tokens,
$0.10 input, $0.50 output, $0.01 cache
reads, and $0.20 one-hour cache writes. These are usage estimates, not inspected
subscription billing or orchestration-agent costs. Credential-free tests submitted
no model prompts.
Raw evidence is ignored under `artifacts/claude-launcher-validation/`.

## Local validation

Local validation passed: the full repository suite returned **253 passed, 46 skipped**
(including Linux-dependent Hostfork checks on this Mac). The final Claude changes
were then covered by the complete **69-test Claude suite** on
Python 3.14.7 and again against the built wheel in an isolated Python 3.12.11
environment. Ruff lint/format checks, lock consistency, all distribution builds
and the strict MkDocs build passed. The HTTP tests emit upstream Uvicorn/websockets
deprecation warnings; they do not fail. These are local results, not a new CI run.

## Remaining gates

- **Actual browser against the Python host:** examples are built, including the
  four-turn concurrent/fork/resume probe, but browser tooling is unavailable in this
  session. Earlier real-Chrome spike success used a TypeScript host and is not
  counted as passing this implementation's gate.
- **Genuine API-key inference:** no API key was supplied to this process. Reference
  resolution and isolation are tested; a real API-key provider call is pending.
- Cloud providers, native or borrowed-token refresh qualification, shared controllers, Remote Control,
  hard manager-crash recovery, complete detached descendant cleanup, full
  plugin/MCP/instruction isolation and live Python clients remain outside the
  qualified first-delivery behavior.

Run local checks from the repository root:

```sh
uv run --frozen pytest packages/claude-launcher/tests -m 'not live'
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mkdocs build --strict
uv build --all-packages
```

Live client probes are explicit commands/buttons in
`examples/claude-client/README.md`. They bound experiment turns and spend without
adding limits to normal launcher sessions. No provider-success mocks count as
upstream compatibility evidence.
