# Claude launcher qualification

**2026-10-13.** This report describes the new Python launcher, separately from the
earlier TypeScript spikes. No release of the new package has been published.
See the [checkpoint and follow-up](claude-handoff.md) for the handoff and priority
order of the remaining work. Costs below cover the Python implementation only.

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
- [Native profile-isolation checks](claude-profile-isolation.md) verified user
  agents, commands, skills, instructions, plugins and MCP configuration with public
  CLI/SDK discovery. Selected project configuration is intentionally shared. All
  14 native workers and eight fixture MCP subprocesses stopped cleanly.
- The repeatable credential-free Node check passed four simultaneous clients over
  two rounds: eight initialization, interrupt and disconnect checks, with all eight
  workers reaped. A forced two-second deadline also exited with no survivors among
  12 tracked owned processes. These are macOS results; the Linux job is prepared
  but has not run.
- `launch --port 0` reports the actual assigned endpoint. A real CLI/HTTP test
  verifies the printed address and listener shutdown.
- Real Chrome **155.0.0.0** through the Chrome DevTools MCP, using the official
  browser SDK against the Python host and genuine API-key authentication: SDK
  initialization, interrupt control, a client-owned prompt hook, streamed Haiku
  inference and saved-history reads passed.
- The four-turn browser probe passed concurrent independent workers, disconnect
  independence, rename, profile history separation, fork/source preservation and
  marker recall in a fork and an explicit resume. The initial attempt failed a
  response assertion after two successful provider turns: asking Claude to
  "remember" the marker produced memory-saving instructions. One retry with
  explicit conversation-only wording passed the same assertions. Both attempts
  are included in the cost ledger.
- Visible browser controls passed a new conversation, a live streamed reply,
  end-session, saved-history selection, inline rename, resume initialization,
  profile switching and fork initialization. Closing the tab stopped the active
  fork worker. All **11 browser-test workers** exited with code 0 and no cleanup
  errors; the manager and tracked descendants were also reaped.

The visible checks found and fixed history buttons overflowing their column when
titles were long. After constraining the grid column, a real click selected saved
history and the list had no horizontal overflow. No browser console errors or
warnings were observed. Mid-turn UI interruption and interactive tool-permission
buttons remain unqualified; SDK interrupt control and prompt hooks passed.

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
| Browser SDK with API key, single-turn probe | Haiku 5.5 | 1 | 0.00048345 |
| Browser concurrent probe, failed response assertion | Haiku 5.5 | 2 | 0.00071088 |
| Browser concurrent/fork/resume probe, successful retry | Haiku 5.5 | 4 | 0.000371925 |
| Browser chat UI with API key, normal launch defaults | Haiku 5.5 | 1 | 0.002327575 |
| **Total** | | **15** | **0.00444142** |

The direct turn reported 453 input and 19 output tokens; the MITM turn reported
455 input and 19 output tokens, both without cache usage. The four-turn flow used
912 uncached input tokens, 160 output tokens, 649 cache-write tokens with a one-hour
TTL, and 649 cache-read tokens. Its incremental estimates were $0.0000469,
$0.0001019, $0.0001410 and $0.00001769. Resume reports cumulative conversation cost,
so the previously observed cost was subtracted rather than counted twice.
The dedicated-login turn reported two uncached input tokens, 603 one-hour
cache-write tokens and 19 output tokens, with no cache reads.

The eight browser/API-key turns added **$0.00389383**, including the failed
attempt. They reported 16 uncached input tokens, 845 output tokens, 26,224
five-minute cache-write tokens and 19,173 cache-read tokens. The successful
four-turn probe's incremental estimates were $0.000175565, $0.00004097,
$0.00010449 and $0.0000509; the last subtracts the source conversation's prior
cost from the resumed cumulative total. The ordinary UI turn used native default
tools and a larger initial context than the tools-disabled probes: 18,567
cache-write tokens account for most of its estimate. Reading history, renaming,
forking and initializing the resumed/forked UI workers submitted no extra prompts.

Independent pricing of the public usage fields agreed with the SDK cost deltas,
using [Haiku 5.5 pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
checked on 2026-10-13 for prompts up to 100,000 tokens: per million tokens,
$0.10 input, $0.50 output, $0.01 cache
reads, $0.125 five-minute cache writes and $0.20 one-hour cache writes. These are
usage estimates, not inspected API invoices, subscription billing or
orchestration-agent costs. Credential-free tests submitted
no model prompts.
Raw evidence is ignored under `artifacts/claude-launcher-validation/`.
The credential-free profile-isolation, concurrency and HTTP checks submitted no model
prompts and added USD 0 in model usage estimates; orchestration costs remain excluded.

## Local validation

Local validation passed: the full repository suite returned **253 passed, 46 skipped**
(including Linux-dependent Hostfork checks on this Mac). The final Claude changes
were then covered by the complete **73-test Claude suite** on
Python 3.14.7 and again against the built wheel in an isolated Python 3.12.11
environment. Ruff lint/format checks, lock consistency, all distribution builds
and the strict MkDocs build passed. The HTTP tests emit upstream Uvicorn/websockets
deprecation warnings; they do not fail. These are local results, not a new CI run.
After the browser fixture and layout fixes, the example bundle, changed-file
pre-commit checks, Claude distribution build and strict MkDocs build passed again.

## Remaining gates

- **Additional browser interactions:** mid-turn UI interruption and simple
  Allow once/Deny permission buttons need live qualification. AskUserQuestion,
  native dialog forms, MCP elicitation forms and image/file attachments remain
  unsupported by the small example. Browser/API-key core interoperability passed
  against this Python host; earlier TypeScript spike results are separate evidence.
- **Linux execution:** the new CI job installs pinned native Claude, builds the
  official client example and runs concurrency and isolation checks. It has not
  been pushed or executed. Larger cloud deployments and Hostfork composition need
  their own qualification.
- Cloud providers, native or borrowed-token refresh qualification, shared controllers, Remote Control,
  hard manager-crash recovery, complete detached descendant cleanup, authenticated
  customization syncing, managed-policy isolation and live Python clients remain outside the
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

After installing the example's pinned pnpm dependencies, reproduce the
credential-free concurrency check from the repository root:

```sh
uv run --frozen python scripts/check_claude_clients.py --clients 4 --rounds 2 --timeout 120
```

It requires a real native Claude executable and Node, checks that the fresh profile
is logged out, and reports versions and lifecycle results without raw captures.
It does not qualify browser or provider behavior.
