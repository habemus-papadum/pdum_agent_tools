# Orchestrator foundation

**S0 checkpoint, 26 October 2026.** A real foreground coordinator, browser/Node
management client, source-linked AIUI application and isolated dev supervisor now
exist. Provider launching and conversation control are **not yet connected**.
The page reads real instance metadata and prepares prompts; it never starts an
agent or sends model input.

## Run

From the repository root:

```sh
./scripts/link-aiui.sh
uv sync --frozen --all-packages --all-extras
cd typescript
pnpm install --frozen-lockfile
pnpm dev
```

The linked AIUI checkout needs its own dependencies installed. It remains a
separate workspace. CI checks out the qualified public AIUI source revision and
installs its selected dependencies before building this app.

The command starts one Python coordinator and Vite, binds available ports, then
prints a JSON `dev-ready` record with URLs, instance/PID identities and state
directory. Ctrl-C stops those owned resources. State remains for inspection;
each invocation gets a different temporary directory. An explicit state directory
must be new. Two invocations can run concurrently with separate profiles/caches.
Use distinct browser contexts and source checkouts when those also need isolation.

```sh
pnpm dev --workspace-directory /path/to/project
pnpm dev --host 127.0.0.1 --port 0
```

Default listeners bind all interfaces. S0 borrows no credentials or native profile.
Shared source edits intentionally affect instances using that same checkout.

## Implemented surfaces

| Surface | Current behavior |
| --- | --- |
| `pdum.orchestrator.Coordinator` | Explicit async ownership, unique instance identity, profile-root directories, retained owner record and idempotent cleanup. Construction/import is inert. |
| `pdum-orchestrator serve` | Mountable Typer CLI, optional FastAPI/Uvicorn, pre-bound port/readiness, signals and optional supervisor-stdin EOF cleanup. |
| `GET /api/status` | Actual service identity, workspace/state/profile paths and implemented capabilities. No inferred provider authentication/readiness. |
| `GET /api/runs` | Current empty provider-run registry. No launch endpoint exists yet. |
| `POST /api/stop` | Expected `instanceId` targets the owner; mismatch returns 409. Correct requests initiate orderly shutdown. This is target hygiene, not a credential/grant. |
| `agent-core` | First scoped identity/evidence contracts, contextual launch values and temporary working-setting resolution. |
| `orchestrator-client` | Browser/Node fetch client for these operations. No automatic retries; transport/5xx failures preserve unknown outcomes. |
| `agent-history/analysis` | Browser-safe existing pricing, dated estimates and explicit missing/unpriced/invalid coverage; Node refresh/CLI compatibility retained. |
| Browser app | Real status/run reads, stale observation retention, context/model preview and text-only prompt preparation through current `aiui-prompts`. |

Preparation is text → semantic record → compiled structured parts → native text
input preview. Whitespace, working overrides and immutable prepared content are
preserved. No Send/launch facade pretends the provider integration already exists.
The single preview context is not yet S1's per-conversation settings owner.

`window.__orchestrator.call('report', {})` lists controls/actions. The same `set`,
`refresh`, `prepare`, source and selection tools drive the page and UI. Draft or
target changes mark the prepared snapshot stale. Failed refresh retains prior
facts without claiming that the host stopped.

## Source linking and HMR

New workspace libraries expose source in development and built publication
entries. AIUI is imported through source-linked package names. pnpm rejects
`link:`/`workspace:` catalog values, so exact catalog entries remain in manifests
while workspace overrides select the intended source paths. Keep those catalog
pins aligned with managed versions when releasing; no registry substitute should
silently replace a local library.

A transitive Solid compiler initially floated beyond the pinned runtime and
caused a real-browser missing-export error despite initial unit/build checks.
Vite/Babel/native compiler versions are now pinned to the qualified AIUI lock
alongside runtime/signals. Updating the set requires a real browser check.

UI edits use an explicit page acceptance/remount boundary. Solid automatic
component refresh is disabled for this qualified release-candidate combination
because it invalidated the whole page in the measured check. AIUI's durable store
and `hotCellGraph` remain their own owners. An actual UI edit updated the view
while retaining its heap, draft, model override and prepared snapshot. An actual
`agent-core` source edit propagated without a package rebuild. Durable store/wiring
edits may still require a full reload; not every source edit preserves state.

## Evidence and remaining work

Real checks cover Python subprocess/HTTP lifecycle, two complete dev instances,
source-linked builds, AIUI tools, desktop and a 390-pixel-wide Chrome viewport.
Wrong-instance stop preserves both owners; stopping one leaves the other running.
Offline/online browser refresh retains stale evidence and recovers. Actual source
lookup and hot-edit paths were checked, not inferred from a successful build.

An isolated command also generated 904 experimental TypeScript files from installed
Codex 0.164.0 and recorded executable/output hashes under ignored
`artifacts/orchestrator-s0/`. The older vendor checkout is **not** claimed to match
that binary. Matching upstream source review and adopting the generated surface
remain S1 qualification before claiming a production Codex client.

This checkpoint made **zero provider calls**. Profile/login/launch APIs, native
live/history views, Claude replay, HP hosting, corpus ingestion orchestration and
full debug capture remain later work. Source/tools inspection is implemented;
a capture toggle is not. CI was updated but has not run remotely in this turn.

Next is [S1's Codex workflow](plans/agent-orchestrator/system/implementation.md#s1-first-useful-codex-workflow).
The [system plan](plans/agent-orchestrator/system-design.md) and
[review decisions](plans/agent-orchestrator/system/decisions.md) remain the design
baseline. These foundations do not imply the whole proposal is implemented.
