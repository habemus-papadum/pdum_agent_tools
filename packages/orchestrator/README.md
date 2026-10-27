# Host coordinator

`habemus-papadum-orchestrator` provides the first production S0 host boundary:
an application-owned async coordinator, a mountable Typer CLI, and an optional
FastAPI/HTTP adapter. It currently serves real instance identity, isolated state,
an empty owned-run list and targeted shutdown. It does **not** launch providers,
authenticate profiles, inspect ordinary agent homes or claim live-agent state.

The [system proposal](../../docs/plans/agent-orchestrator/system-design.md) assigns
those later operations to this library's composition of existing launchers.

## Start one foreground instance

From the repository root:

```sh
uv run --all-packages --all-extras pdum-orchestrator serve \
  --state-directory /tmp/my-new-orchestrator-instance \
  --workspace-directory "$PWD"
```

The state directory must be new. Omit it to allocate a unique temporary directory.
Every instance gets separate `profiles/codex`, `profiles/claude` and `profiles/hp`
roots, plus an `instance.json` ownership record. These are empty development roots,
not newly authenticated native profiles. State/evidence remains after shutdown;
the enclosing development supervisor may remove its own state separately.

The default bind is `0.0.0.0`, port `0`. One JSON readiness line is emitted only
after the actual socket has been bound and HTTP startup completed:

```json
{"type":"orchestrator-ready","apiVersion":"0","instanceId":"…","url":"http://127.0.0.1:PORT","boundHost":"0.0.0.0","pid":123,"processStartedAt":123.4,"stateDirectory":"…","workspaceDirectory":"…"}
```

`url` is the local supervisor's reachable address for a wildcard bind;
`boundHost` states the actual listening interface. Remote advertised endpoints
are a later host-routing concern. Logs/errors go to stderr, not the readiness stream.

SIGINT/SIGTERM performs orderly cleanup. A Unix development supervisor can pass
`--exit-on-stdin-eof`, keep the child's stdin pipe open, and close it when its
owner ends. This optional pipe only conveys lifetime, not a command protocol.
It is disabled for ordinary terminal usage. CLI signal/pipe behavior is currently
qualified on Unix; no Windows hosting guarantee is made by this slice.

## Management contract

| Operation | Implemented behavior |
| --- | --- |
| `GET /api/status` | API version, instance/host identity, PID plus process creation time, start/stop clocks, state/workspace directories, isolated profile roots and implemented capabilities. |
| `GET /api/runs` | `{"runs":[]}`. No provider-launch operation exists in S0. Empty means no owned runs, not a scan of the machine. |
| `POST /api/stop` | Body `{"instanceId":"…"}`; returns `{"instanceId":"…","accepted":true}` before graceful shutdown. A different instance ID gets HTTP 409 and stops nothing. |

The instance ID is a target check, not a secret or access grant. The trusted-network
defaults add no authentication layer, expiry or client lease. S0 capabilities are
exactly `status`, `runs`, and `stop`; unavailable agent operations are not simulated.
The HTTP adapter requests stop on the existing owner; it does not signal a caller-
supplied PID or create another manager. Importing modules or mounting the Typer app
does not allocate state, install signal handlers, start a listener or launch work.

The async library remains independent of HTTP:

```python
from pathlib import Path
from pdum.orchestrator import Coordinator
from pdum.orchestrator.server import open_server

async with Coordinator(state_directory=Path("/tmp/new-instance")) as owner:
    async with open_server(owner, host="127.0.0.1", port=0) as server:
        print(server.readiness())
        await server.wait()
```

`open_server` owns its listener and observes the coordinator's stop request. It
installs no signal handlers and does not close the coordinator itself; the outer
application context owns that lifecycle. `management.create_app(owner)` supplies
the routes alone. `cli.create_cli()` returns a mountable Typer application. HTTP
dependencies are in the `management` extra; importing the core needs no Node,
provider SDK or FastAPI installation.

## Slice plan and evidence

S0 establishes real host identity/lifetime before provider composition. No unresolved
product behavior is implemented: later profile/auth/launch operations remain absent.
This carries the runtime contracts into concrete checks:

- **RC-07/08:** distinct instance records, process identities and endpoints; no
  automatic adoption of prior state or claim that a surviving record is a live owner.
- **RC-11:** running HTTP is not authenticated model access; no credentials or paid
  request are touched by startup or inspection.
- **RC-12:** workspace/profile/run scopes remain distinct. No conversation is created
  by reading status, and this slice does not implement native history continuation.

Tests use real subprocesses and HTTP listeners to check independent instances,
wrong-instance stop, orderly SIGTERM/pipe-EOF cleanup, state collision and failed
listener startup. No provider processes or model calls are used. The stopped
instance record is inspectable; it does not establish crash recovery. Later provider
composition must add its own native/browser/Node acceptance checks.

```sh
uv run --all-packages --all-extras pytest packages/orchestrator/tests
uv run ruff check packages/orchestrator
uv run ruff format --check packages/orchestrator
uv build --package habemus-papadum-orchestrator
```
