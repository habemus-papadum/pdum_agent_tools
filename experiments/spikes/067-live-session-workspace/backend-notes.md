# 067 backend: owned sessions only

**25 October 2026.** Disposable application glue over the existing launcher
libraries. No external Claude discovery, native terminal attachment or adoption
of an app-server started elsewhere is implemented.

`server.mjs` exports `handleRequest(req, res, url)` for `/__session-lab/*` and
`closeLiveLab()` for preview-host cleanup. The first request lazily starts one
application-owned Python service. Configuration reads do not launch providers.
The service exits when its Node owner's stdin pipe closes and closes all owned
provider runtimes. It is not a separately installed daemon or a production
coordinator protocol.

## Concrete routes

| Same-origin route | Owner and effect |
| --- | --- |
| `GET /__session-lab/config` | Lab workspace, two provider choices, credential-reference presence and current in-memory run records. No credential values are returned; presence is not successful model access (RC-11). |
| `POST /__session-lab/sessions` | `{provider,cwd,qualification?}`. Creates the provider's lab profile if absent. Codex starts an owned app-server; Claude allocates a worker that starts only when the official SDK connects. Returns the `Run` contract. |
| `POST /__session-lab/sessions/{id}/identity` | Records the browser-created Codex `threadId`. An established identity cannot be silently replaced. Claude's native conversation ID is known at allocation. |
| `GET /__session-lab/sessions/{id}/history` | Reads the current native history, without resume or subscription. After ending, returns the snapshot captured before shutdown with `cachedAfterEnd: true`. |
| `POST /__session-lab/sessions/{id}/capture` | Saves the browser's native/SDK message observations under ignored artifacts. This explicit operation is independent of forwarding; no payload cap/truncation is imposed. |
| `POST /__session-lab/sessions/{id}/end` | Attempts a final native snapshot, then stops the owned runtime even if history is unavailable. History failure remains in the response. |
| `GET /__session-lab/sessions` | Only this application's in-memory run records; not machine-wide discovery. |

`Run.state` describes this owner's ready/ended state, **not** native turn completion
(RC-01). The browser owns streaming turn state and explicit input operations.
Provider WebSocket URLs connect directly to the owned launcher relay; the Node
preview adjusts their hostname for the page's host. HTTPS/reverse-proxy deployment
has not been qualified.

## Profiles, authentication and lifetime

Default state is ignored `experiments/artifacts/067-live-session-workspace/`.
`PDUM_LIVE_LAB_DIR` selects another directory for concurrent experiments. The two
profiles are `profiles/codex` and `profiles/claude`; `workspace/sample.txt` provides
a real small file for bounded tool-call qualification.

- Codex uses `ProfileSpec(model="gpt-6-luna", copy_auth=True,
  auth_source=..., copy_skills=False)` with **no configuration source**. Only the
  file-backed authentication snapshot is copied. Native config is fresh, sandbox
  and approvals follow the repository defaults, and user settings/skills/MCP are
  not imported. Native Codex may seed its own bundled skills at startup. The source
  is `default_codex_home()/auth.json`, or explicit `PDUM_CODEX_AUTH_SOURCE`; it is
  never written. Copied refresh credentials retain the existing launcher's caveat
  that separate refresh owners can invalidate either session.
- Claude uses one isolated base profile, cloned in memory with the chosen working
  directory for each run. `PDUM_CLAUDE_TOKEN_FILE`, defaulting to the verified 066
  setup-token file, is resolved at allocation and injected through existing
  `LaunchOptions.environment`. The token is absent from status/capture metadata.
  Saved profile auth metadata remains native; this is a host injection experiment,
  not a newly shipped `AuthSpec` method.
- Ordinary UI allocations have no experiment quota. `qualification: true` applies
  Claude's two-turn/USD 0.05 bounds only to explicit automated probes. Codex is
  fixed to Luna; the controlling check bounds its own turns/time.
- Browser disconnect ends a Claude worker under the existing contract. A Codex
  server remains owned by the lab until explicit **End** or preview-host shutdown;
  its native subscriber/idle lifecycle remains native (RC-02/03/08).

No old process handles are recovered after service loss. In-memory run selection
is lost; JSON evidence and native history remain on disk. No blind resubmission
or automatic resume is performed (RC-05/07).

## Native history and observation boundaries

Codex snapshots use a new connection to the already-owned server, then only
`initialize`, `thread/read`, `thread/turns/list` and `thread/items/list`. Native
response envelopes and item timestamp wrappers are retained, including pagination
errors. Empty threads may be unmaterialized; that is an explicit unavailable result.
No thread start/resume is performed by the history reader. The browser performs
the initial `thread/start` before registering its ID.

Claude snapshots call the production `History.info/read` adapter, which invokes
the official Python SDK helpers with fixed profile/workspace context and without
credential resolution. Live browser SDK messages and saved history have different
coverage; the service does not invent missing clocks, result events or cost fields
(RC-09/10/11).

## Focused no-inference qualification

Run from the repository root:

```sh
.venv/bin/python experiments/spikes/067-live-session-workspace/backend_check.py
```

Eight actual checks passed: config inspection creates no provider/profile;
owned Codex process initializes and creates an empty thread without a turn;
unmaterialized history is explicit; ending reaps its actual PID; auth-only copy
preserves the source and imports no source configuration/skills; Claude allocation
records identity and scoped credentials without a process; unconnected allocation
cleanup is complete; concurrent shutdown includes a native launch still in flight.
The check uses deliberately invalid credentials in temporary
state and submits **zero model inputs**, so it proves no authenticated inference.
Root-owned browser qualification supplies real tool/history and spend evidence.
