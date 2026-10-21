# 057 — Sending turns after inactivity through our launcher

**Observed on Codex 0.163.0, macOS, 19 October 2026.** Our launcher can remain
transparent. An unloaded conversation needs an explicit native `thread/resume`
before `turn/start`, but the client library can manage that at attachment and
reconnection boundaries. It does not need to query status before every message.

An open, subscribed conversation does **not** become inactive merely because
the person stops typing. Automatic unload requires both no thread subscribers
and no active turn. A WebSocket being open is not enough if that connection has
never attached to this particular thread.

## What happens when sending

| Client situation | Native behavior and suitable client action |
| --- | --- |
| Created/joined thread, subscription still present | Send `turn/start` directly. No heartbeat or per-message status request is necessary. |
| Opening a saved conversation or reconnecting | Initialize the connection and call `thread/resume` once. This joins a loaded runtime or reconstructs one from history, then subscribes the connection. |
| Send directly to an unloaded thread | Returns `-32600`, `thread not found: <id>`. It does not load the conversation or accept that turn. |
| Resume while teardown is pending | Native error says the thread is closing and to retry resume after closure. A bounded resume retry can handle that transition. |
| Connection fails after submitting input | Outcome may be unknown. Reconcile; do not automatically replay the prompt as though it were rejected. |

The live relay test received exactly:

```json
{"error":{"code":-32600,"message":"thread not found: <id>"},"id":"live:8"}
```

There is no structured “unloaded” discriminator in this error. The same error
can describe an unknown thread ID, and `-32600` covers other invalid requests.
A future helper can recognize this specific rejection for a known conversation,
resume it, then retry the rejected turn once. That is a client convenience to
design, not a behavior implemented in our launcher. Other failures must preserve
their native code/message/data and delivery uncertainty.

Resume can activate a saved goal. A concurrent `turn/start` can join an already
active turn, so the helper must reconcile the resumed state and retain the user's
intended steering/queueing behavior. Do not call resume before every turn or use
it merely to inspect history.

## Existing hooks are enough for this boundary

The production launcher creates one native connection for each relay client and
forwards frames unchanged. Its asynchronous `MessageProcessor` interface already
sees incoming/outgoing messages. Native `thread/status/changed` with `notLoaded`
and `thread/closed` can invalidate the client's attached state; connection loss
does the same. `thread/closed` supplies the thread ID, without a teardown reason.
The live observer received both unload notifications without subscribing to the
conversation; it did not prevent unloading.

The launcher needs no conversation cache, automatic resume, prompt retry or
additional subscription. A future coordinator may keep a passive initialized
connection for broadcast notifications without resuming all threads. Relay-only
inspection cannot see native traffic when no upstream connection exists.

## Configuring the delay

The native top-level setting defaults to 1,800 seconds. Our existing launch API
already accepts it without a new launcher setting:

```python
LaunchOptions(config_overrides={"thread_unload_delay_secs": "7200"})
```

```sh
uv run pdum-codex --profile research launch -c thread_unload_delay_secs=7200
```

It can also be saved at the root of that profile directory's native `config.toml`.
This is an **app-server startup setting**, requiring a server restart; it is not
a per-conversation timer or a field in native `[profiles.*]` configuration.
It accepts nonnegative integer seconds. **Zero means immediately eligible for
unload, not disabled.** No forever/disable sentinel was found. Keeping a thread
subscription prevents ordinary timed unloading; a longer finite delay merely
postpones it. Extremely large values can fail the platform time-range check.

## The background-terminal concern was reproduced

This follow-up directly tested what 056 had established from source:

1. Real Luna launched one managed Python process that wrote heartbeats every
   200 ms and would naturally exit after 120 seconds.
2. The model completed its turn. Native status was `idle`, the terminal registry
   listed the process, and its verified OS PID was alive.
3. It continued beyond the three-second delay while the client stayed subscribed.
4. After unsubscribe, automatic unload occurred after **3,024 ms** in one run
   and **3,066 ms** in the other. The PID was gone, heartbeat writes stopped, and
   the process had not reached its natural exit.
5. The app-server stayed running. Explicit resume restored the conversation ID
   and a subsequent real turn succeeded through the same relay. The terminal
   registry was empty: the old process was not restored.

This is real teardown, not a suspended process. Source explicitly drains and
terminates managed processes, including process-group cleanup on macOS. It does
not establish that every detached external service or remote executor is killed
successfully. Source also shows that resuming an unsubscribed idle runtime with
different configuration can rebuild it before the timer expires; plain rejoin
should avoid gratuitous overrides.

For work intended to survive closing a conversation, we should later choose
between an intentional retained subscription and a separately owned durable
job. This spike does not install either policy.

## Evidence and limits

Two actual production-launcher/relay runs used three Luna turns in total.
The second run passed **16 runtime assertions**, then hit an overbroad harness
check that assumed the whole config file stayed byte-identical. Native
`thread/start` had added project trust inside the isolated profile. Saved-evidence
verification confirmed the unload-delay override itself remained absent on disk;
the probe now checks that specific property. The first run stopped after 12
passing checks on a wrong launcher PID-field lookup. Both original failures are
retained; we did not pay for a third full run solely to recheck those harness fixes.

The estimate across both runs is **$0.00219116 API-equivalent**, using observed
cumulative tokens and dated rates, not actual subscription billing. Normal
credentials/configuration/sessions were unchanged. No production behavior was
modified. See [reproduction, exact source anchors and usage ledger](../../spikes/057-launcher-inactive-turns/README.md).
