# Spike 016: foreground worker lifecycle

**Result, 2026-10-13:** The thin relay's tested lifetime rule works without a
model request: one client connection owns one native Claude worker. Closing the
official browser SDK transport under Node, closing the virtual-process Node SDK
transport, abruptly terminating a TCP client, or losing an unresponsive client
stopped the corresponding worker and reaped its PID. Two workers sharing one
isolated profile remained independent when one client disconnected. The server
does not initialize or interpret the SDK protocol; each SDK client owns its own
native initialization and callbacks for its worker.

The local probe created empty HOME, config, temporary and work directories. Both
SDK initializations reported `tokenSource: none`; no user turn or inference call
was sent. The browser SDK check used its official browser export **under Node**,
not an actual browser page. A separate browser harness is needed for an actual
reload or tab-close claim.

| Case | Observed result |
| --- | --- |
| Browser SDK close | Native worker reached `stopped`; its PID disappeared. Another worker on the same profile stayed `connected` and alive. |
| Virtual Node SDK close | Its own worker reached `stopped`; its PID disappeared. |
| Abrupt TCP close | A raw WebSocket client initialized the real worker, then called `ws.terminate()`. The worker stopped and its PID disappeared. |
| Silent TCP client | After initialization, a client paused socket reads and stopped answering WebSocket pings. The 250 ms probe heartbeat reported `heartbeat timeout` and reaped its worker. |
| Published browser SDK keep-alive | During a real 58-second credential-free idle interval, the browser SDK sent one `keep_alive` frame through the raw relay. The worker stayed `connected`; a subsequent SDK `interrupt()` resolved, and SDK close reaped the worker. |
| Pre-initialization failure and disconnect | A client sent malformed JSON then disconnected before initialization. The connection loss reaped its worker. The relay forwards raw bytes, so this does **not** show server-side JSON rejection. |
| Manager close / SIGTERM | Calling `manager.close()` with an incomplete HTTP request body and signalling a separate manager process with SIGTERM each reaped the owned native worker. The partial request did not keep close pending; the SIGTERM child exited with code 0. |
| Manager SIGKILL | In this run, killing the manager also led to native worker exit after its stdin pipe closed. JavaScript cleanup cannot run on SIGKILL, so this observation is not an orphan-prevention guarantee. |
| Native stdin EOF | A real initialized native stream-JSON worker exited with code 0 on stdin EOF, without TERM or KILL escalation. |

## Reproduce

From `experiments/`, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @agent-spike/016-claude-client-sessions typecheck
pnpm exec tsx spikes/016-claude-client-sessions/src/lifecycle-probe.ts \
  artifacts/016-claude-client-sessions/lifecycle-new-run
pnpm exec tsx spikes/016-claude-client-sessions/src/lifecycle-keepalive.ts \
  artifacts/016-claude-client-sessions/keepalive-new-run
```

Use a fresh output path. The [probe source](../../spikes/016-claude-client-sessions/src/lifecycle-probe.ts)
and [child manager](../../spikes/016-claude-client-sessions/src/lifecycle-child.ts)
contain the exact assertions and bounded waits. The child receives an explicit
isolated profile, publishes its own manager PID, and handles SIGTERM by awaiting
`manager.close()`. The parent tracks only PIDs returned by its launched workers;
on an exceptional probe failure it kills the known owned worker process group.
It never enumerates or cleans up unrelated Claude processes.
The separate [idle keep-alive probe](../../spikes/016-claude-client-sessions/src/lifecycle-keepalive.ts)
waits for the published SDK's own frame; it does not send a synthetic heartbeat.

## Evidence and limits

The passing run is under ignored
`artifacts/016-claude-client-sessions/lifecycle-20261013-c/`: case summary,
manager status, raw local worker streams, and child results. Those files are local
runtime captures and are not publication material. Assertions checked both
server status and OS PID disappearance; the SIGKILL case checked OS PID exit
after the manager process exited. Native EOF was tested separately because it is
the mechanism expected when a killed manager loses its stdin pipe handles.
The keep-alive run is under ignored
`artifacts/016-claude-client-sessions/keepalive-20261013-a/`. Its relay input
types were `control_request`, `keep_alive`, `control_request`; the final control
was the successful interrupt after the idle interval. The worker then stopped
on browser SDK disconnect. The 58-second idle window produced one SDK heartbeat
and no model request.

Environment: Node **26.10.0**, Agent SDK **0.3.296**, bundled native Claude
**2.1.296**, Darwin **25.6.0** arm64. Model requests: **0**. SDK estimated model
cost: **USD 0** for this credential-free probe; no billing record was inspected.

These checks do not cover an active inference turn, SDK-hosted tool callbacks,
background tasks or descendants that outlive the native process. A silent client
was detected with a 250 ms probe heartbeat; the manager's default is 1000 ms.
An HTTP launch followed by no WebSocket connection remains `waiting` with a live
worker until explicit DELETE or manager shutdown; a separate credential-free
review probe confirmed that after 1.2 seconds. There is no automatic waiting
worker expiry in this trusted, foreground experiment.
SIGKILL cleanup remains a best-effort kernel pipe behavior, not a durability or
recovery contract. No detached-worker recovery or session replay is implemented
by this probe.
