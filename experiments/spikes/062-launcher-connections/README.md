# Launcher connections

**Working disposable study, 24 October 2026.** Open `/connections/` in the shared
055 lab. This page reads actual local profiles and existing provider management
APIs. Its source/configuration seams are temporary; it does not implement the
proposed unified coordinator.

## Try the journey

1. Scan the local profile table, filter it, and inspect a Codex home. The process
   rows come from the existing launcher inspection library, not invented agents.
2. Open a profile in the workbench. Ordinary profiles are read-only there; new
   lab copies are editable.
3. Choose **Claude manager**, enter an existing HTTP management URL, and connect.
   Read its actual profile list and worker counts. The included worker-free
   adapter at `http://127.0.0.1:63929` was left running for this review.
4. Try an unavailable endpoint or the wrong provider selection. Failure is real.
   If an already observed endpoint fails on refresh, its last successful snapshot
   remains available and explicitly stale.
5. **Forget** removes a tab-local observation. It sends no stop request.

The dense header and controls stay anchored; tables and details scroll in the
remaining space. Space opens the shared command map. Phone widths retain the
same application tree with a horizontally scrolling host strip and data tables.
Engineering commentary is in Study/these notes; there are no synthetic outcome
controls.

## What is real

| Choice | Existing owner / operation | Scope |
| --- | --- | --- |
| Local profile discovery | Codex `inspect_profile` and named metadata; Claude `load_profile`; launcher default profile roots | Ordinary Codex home, named profiles and this lab's created profiles; does not scan the entire disk. |
| Inspect Codex | `pdum.codex_launcher.inspection.inspect_home(probe_daemon=False)` | Real processes, run-record liveness, writer-lock files and database metadata. No socket probe, thread subscription or recovery. |
| Inspect Claude | `pdum.claude_launcher.profiles.load_profile` | Native profile metadata. There is no claim of machine-wide worker discovery. |
| Connect Codex manager | Existing FastAPI `GET /status`, `GET /inspect?probe=false` | One manager/server's observations. The selected API shape is checked before recognition. |
| Connect Claude manager | Existing FastAPI `GET /api/profiles`, `GET /api/status` | One manager's registered profiles and workers. An empty worker list is meaningful. |
| Open profile | `/profiles/?provider=…&path=…` | Local inspection target preserved. Remote profiles are displayed but not passed to local editing. |

HTTP requests are made by the lab host, so the URL is resolved from that machine.
The form takes the existing manager's **HTTP base URL**, not a conversation
WebSocket. It supports an existing path prefix. Network errors, non-JSON results,
HTTP errors and mismatched provider shapes remain failures. No mandatory access
scheme or replacement configuration format was added.

The connection list is durable across component/graph HMR, not across a page
reload or host loss. This is observation, not a maintained live transport. Reachable
means the expected HTTP read endpoints answered; it does not establish model
entitlement, task health or survival on coordinator failure.

## Source and process ownership

`server.mjs` exports `handleRequest(req,res,url)` for the shared preview host under
`/__management-lab/`. `bridge.py` runs in the repository's existing root Python
environment and delegates local profile operations to the production libraries.
It also serves 063's profile editor. No production package changed.

`local-manager.py` runs the **existing** Claude FastAPI adapter with lab profiles
and no worker allocations. It does not launch Claude or read credentials. Start
another isolated instance from the repository root:

```sh
uv run python experiments/spikes/062-launcher-connections/local-manager.py
```

It prints an OS-selected loopback port; `PDUM_STUDY_MANAGER_PORT` can select one.
For this review it runs detached on port 63929. Its PID/URL are recorded in ignored
`experiments/artifacts/062-launcher-connections/manager.json`, with its log beside
that file. Recheck that PID's command before stopping it. The current ownership
snapshot is PID **7649**; it is not a permanent identity. The adapter's ordinary
write routes exist, but this page invokes only GET inspection routes. Keeping a
worker-free manager alive does not imply an implemented daemon/recovery design.

## Questions and limits

- Unified host discovery, transport authentication, automatic reconnection,
  long-lived subscriptions and remote profile mutations remain later slices.
- A process is not a task and a writer-lock file is not proof of a currently
  executing turn. **RC-01/02/07/08** apply: observation must not become task
  completion, subscription retention, or a universal provider lifetime promise.
- Claude's profile list and worker list are manager-local. A future coordinator
  must compose those owners rather than assume this inventory is exhaustive.
- Normal profile inspection can be relatively expensive because it examines
  processes and native databases. There is no polling loop or metadata cache yet.

## Checks and cost

Two focused Node integration tests cover real Codex/Claude profile operations,
source preservation/write boundaries, native unknown fields, and unrelated
HTTP-200 JSON rejection:

```sh
node --test spikes/062-launcher-connections/bridge.test.mjs
```

Run from `experiments/`. Actual browser checks at 1440×900 and 390×844 exercised
local discovery, Codex process inspection, the real worker-free Claude adapter,
failed reconnect with retained previous evidence, and profile navigation. No page
horizontal overflow or browser warnings/errors appeared in the final checks.
A different physical host/network and the Codex HTTP adapter were not live-tested
in this round; Codex local inspection was.

Provider inference cost: **USD 0**. No login or agent turn was started. Ordinary
profiles and source histories were not modified. Implementation-assistant cost is
not included in that number.
