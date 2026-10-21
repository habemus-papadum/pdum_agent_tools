# 057 — Launcher, inactive turns and managed terminals

**19 October 2026.** [Read the findings first](../../docs/spikes/057-launcher-inactive-turns.md).
This follow-up to 056 checks the actual production launcher/relay, rather than
using a separate direct app-server harness. Production packages are unchanged.

## Reproduce

From `experiments/`, with the root workspace installed:

```sh
uv run --no-project /ABS/REPO/.venv/bin/python spikes/057-launcher-inactive-turns/probe.py --live
```

The runner reuses 028's JSON-RPC client and accounting scaffolding, with current
profile layout and dedicated bounds: at most two paid Luna turns per invocation,
160 seconds, eight tool items and $0.10 observed API-equivalent allocation.
Defaults are explicitly `gpt-6-luna`, low effort, default tier, approvals off and
sandbox off. The live flag is required for deliberate reproduction. The source
login is read once; tokens are supplied to a fresh isolated server via
`account/login/start`. Its source file hash is checked afterward. Raw relay
captures can contain credentials and remain under ignored artifacts.

A single managed process writes a heartbeat in the fixture work directory. Its
command and PID/create-time identity are verified before checking termination.
It has a 120-second self-stop, and cleanup targets only that verified process.
The observer connection does not resume or subscribe to the test thread.
The unload delay is shortened to three seconds through `LaunchOptions`.

Installed identity: `codex-cli 0.163.0`, SHA-256
`8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`, macOS arm64.
Source anchors below target release commit
`83086188ae0614bd882818ff1aa23f3194962012`; the ignored vendor worktree remains
unchanged at its older research pin. Public rates were checked against the
[official Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Observations and usage ledger

Private evidence root: `experiments/artifacts/057-launcher-inactive-turns/`.

| Run | Real model turns | Passed runtime checks | Unsubscribe → unloaded | Observed API-equivalent estimate |
| --- | ---: | ---: | ---: | ---: |
| `1792423837196` | 1 | 12 | 3,024 ms | $0.00079454 |
| `1792423898790` | 2 | 16 | 3,066 ms | $0.00139662 |
| Total | 3 | Distinct cases described below | | **$0.00219116** |

| Run | Input tokens (including cached) | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| `1792423837196` | 28,026 | 22,784 | 0 | 85 |
| `1792423898790` | 42,106 | 31,872 | 0 | 109 |

The 19 October rates per million tokens were $0.10 uncached input, $0.01 cached
input, $0.125 cache write and $0.50 output. Totals are cumulative per native
thread, not sums of duplicate notifications received by both clients. Actual
subscription billing, unreported provider activity and implementation-assistant
charges are not measured. These are estimates of the observed usage.

The first run confirmed live heartbeat termination and native turn rejection,
then stopped on a harness `KeyError: 'pid'`: launcher identity lives under
`status['server']`. The second confirmed the same behavior plus explicit resume
and successful new turn in the same app-server process, then stopped on an
overbroad whole-config hash assertion. Native `thread/start` persisted a project
trust entry in the isolated home; the delay override was not written to config.
Neither original `result.json` was changed to pretend the whole run passed.

The corrected persistence check was applied to retained evidence without another
provider invocation:

```sh
uv run --no-project /ABS/REPO/.venv/bin/python \
  spikes/057-launcher-inactive-turns/verify_saved.py \
  artifacts/057-launcher-inactive-turns/1792423898790
```

It passed, writing `post-run-verification.json`: 16 prior runtime checks,
effective delay 3, override absent on disk, normal source-auth hash unchanged.
The final runner contains the corrected assertions; a third end-to-end run was
not performed. Relay status during the successful resumed conversation recorded
206 messages, zero transport errors, zero recorded loss and one observation
still awaiting asynchronous recording at the snapshot. Closing drains that
processor; the snapshot itself is not asserted to be fully drained.

The capture also shows both `thread/status/changed` → `notLoaded` and
`thread/closed` arriving on the passive observer connection, which had never
resumed/subscribed to the thread. This supports a future coordinator's passive
status connection without retaining every runtime.

## Client flow recommended for the next implementation slice

```text
open/reconnect → initialize → resume(threadId) once → attached
attached + send → turn/start directly
disconnect / thread/closed / notLoaded → mark local handle detached
explicit send/open while detached → reattach, reconcile state, then apply intent
```

Keep attachment state scoped to connection + thread. Sharing UI listeners does
not require new native subscriptions; removing a local listener is distinct from
native `thread/unsubscribe`. A raw `turn/start` sent from an unsubscribed socket
does not itself attach that socket to a still-loaded thread.

The launcher remains a transport/process owner. A future SDK may offer a
single-flight reattach helper so simultaneous views do not issue redundant
resumes. This is a design recommendation, not implemented behavior or a fixed
recovery policy. In particular, resume can activate goals and a concurrent
`turn/start` can append input to an existing active turn; honor explicit
steer/queue intent after reconciliation.

| Native signal | Client interpretation |
| --- | --- |
| `thread/status/changed`, `status.type: notLoaded` | Runtime is not loaded in this server. |
| `thread/closed` | Invalidate attachment for that thread; no typed close reason is supplied. |
| Transport closes | Connection and its subscriptions have ended; delivery may be unknown. |
| `turn/start`: `-32600`, `thread not found: <id>` | Lookup rejected before submission. A known ID can be resumed and that rejected input retried once, if the chosen policy allows it. |
| `thread/resume`: `-32600`, `thread <id> is closing; retry thread/resume after the thread is closed` | Await closure or use a bounded resume retry. Even receipt of closed can race the final pending-unload marker removal. |
| `turn/start`: `-32603`, failed to submit turn input | May be a teardown race. Do not classify every internal error as safe prompt replay. This error path was source-inspected, not forced live here. |

Both `-32600` cases have no structured subtype/data. Unknown IDs can produce the
same thread-not-found message. Keep original RPC method, code, message and data;
use narrowly tested version-specific classification rather than retrying every
invalid request. Timeouts and transport loss are not rejected-before-submit
evidence. Passive reads remain distinct from resume.

## Source map

All native links are to the installed release's source. The local launcher links
are the working implementation exercised by the live probe.

- [Turn lookup](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/turn_processor.rs#L377)
  and [turn/start](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/turn_processor.rs#L532): loaded runtime lookup, not cold resume.
- [RPC error construction](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/error_code.rs#L3)
  and [submission](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/turn_processor.rs#L661): preserve native errors and distinguish acceptance uncertainty.
- [Resume while closing](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_processor.rs#L3850),
  [serialized warm attach](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L846),
  and [override rebuild](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_processor.rs#L4566).
- [Top-level delay declaration](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/config/src/config_toml.rs#L349),
  [default/range](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/mod.rs#L4031),
  and [listener config capture](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_processor.rs#L1097): server restart required; zero is immediate; no disable sentinel; per-thread overrides do not replace this startup setting.
- [Session shutdown](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/handlers.rs#L290),
  [terminate all registered processes](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/unified_exec/process_manager.rs#L1822),
  [local/remote termination](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/unified_exec/process.rs#L243),
  [PTY cleanup](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/utils/pty/src/pty.rs#L93),
  and [macOS process-group kill](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/utils/pty/src/process_group.rs#L273).
- [Native project-trust persistence](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_processor.rs#L1377): explains the whole-config hash change; ordinary developer configuration was not touched.
- [Our relay](../../../packages/codex-launcher/src/pdum/codex_launcher/relay.py),
  [observation hooks](../../../packages/codex-launcher/src/pdum/codex_launcher/observation.py),
  [native launch options](../../../packages/codex-launcher/src/pdum/codex_launcher/runtime.py)
  and [CLI](../../../packages/codex-launcher/src/pdum/codex_launcher/cli.py).

## Limits

This directly qualifies ordinary local managed terminals, not arbitrary detached
daemons, remote executors, every child-agent lifecycle, crash survival or all
configuration combinations. Remote termination is best-effort/asynchronous in
the inspected source. The three-second timer is an accelerated check of the
same path; the 30-minute default and restart-only scope are source-qualified.
Native cold/closing races and goals require the separate client intent policy
described above. The proposed production SDK has not been implemented.
