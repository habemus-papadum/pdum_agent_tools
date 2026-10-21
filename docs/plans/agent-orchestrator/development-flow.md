# Development flow and packaging: isolated first

**Status: proposed development direction, 19 October 2026.** The user wants
ephemeral development instances so multiple agents can work concurrently, even
though the eventual coordinator/components should be shareable and robust.
Browser/Electron packaging remains open. [O22](components/22-development-delivery.md)
is the discussion entry; this sketch does not implement a live dev supervisor
or an Electron application.

## Mocks are independent of the delivery decision

The current work is two throwaway web pages with separate Markdown descriptions
of the interactions they explore. Those notes, plus user feedback, will feed a
later concrete specification. Mock code is disposable and need not become the
production SDK, component library or development stack.

The latest mock iteration uses actual Solid/AIUI components, scoped controls,
durable resources and cell graphs, compiled by Vite with AIUI's source plugin.
The overview's DuckDB fixture database lives only in its browser tab. Both apps
mount the requested internal AIUI dock as local study scaffolding; tools/source
inspection is qualified, provider/oracle connections are not. No backend or
Electron decision is needed to evaluate the interaction.

Their [preview runbook](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/055-orchestrator-mock-lab/README.md)
describes one foreground HTTP/Vite host. It allocates its port, temporary cache
and instance record. Graph/UI hot edits preserve selected working state; an
explicit reload or wiring/store edit may reset it. A literal call-site HMR
acceptance marker was needed alongside `hotCellGraph`. Two concurrent preview
processes and independent cleanup are tested. This establishes frontend-preview
isolation, not isolation of a future coordinator or browser profiles. GitHub
links become available when the changes are committed/pushed.

## Candidate development and delivery modes

| Mode | Useful for | What remains to establish |
| --- | --- | --- |
| Static browser mock | Fast interaction/visual review; headless or session-browser automation. | Its fixtures are not provider compatibility or production architecture. |
| Browser plus dev backend | Primary proposed live-development lane: Vite/source linking plus an isolated foreground coordinator. | Actual WebSocket routing, readiness, process/profile/database isolation and lifecycle tests in this repo. |
| Portable Electron shell | Bundle local runtimes and provide desktop conveniences while reusing the browser-compatible frontend. | The desktop operations we need, service ownership, packaging and compatibility with this workspace's tooling. |
| Desktop-focused Electron app | Tray/global shortcuts/native windows or other features that define the product. | User need before committing to a desktop-specific UX. A browser deployment may later be retired, while headless core-UI tests can remain useful. |

Start the live dev lane in a browser unless a concrete desktop need changes the
choice. Keep host-specific operations behind explicit adapters so the same
frontend can be exercised in Electron later. Running both during investigation
is reasonable; it does not commit us to supporting both indefinitely.

## One instance, one set of owned resources

The future dev command should report its instance ID, source root, actual
frontend/coordinator endpoints, state locations and cleanup ownership in both
readable and structured form. No fixed shared ports or implicit attachment to
the operator's production coordinator are needed. The frontend can use logical
management routes, while returned conversation endpoints retain the provider
SDK handoff. HTTP proxy examples do not establish WebSocket correctness.

| Resource | Development isolation to qualify |
| --- | --- |
| Source | Separate checkout/worktree for conflicting edits; explicit ownership of disjoint folders otherwise. Instances sharing source intentionally see those edits. |
| Listeners | Bind available ports and report the bound address; avoid finding a free port and racing to bind it later. |
| Coordinator/agent profiles | Per-instance test roots and explicit credential references/reuse. Do not mutate ordinary developer profiles or launch agents merely by opening a page. |
| Database/history | Per-instance fixture/scratch stores or deliberately read-only inputs; shared production analytics is an explicit selection, not a dev default. |
| Browser | Choose the session's MCP-connected browser deliberately. Independent instances need separate browser contexts/profiles when storage/login isolation matters; separate tabs alone do not establish that isolation. |
| Builds/caches | Separate Electron main/preload output, runtime directories and mutable caches where tools can overwrite each other. |
| Logs/captures | Instance-labelled output under ignored locations; distinguish temporary state from diagnostic evidence intentionally retained after failure. |
| Shutdown | Stop only recorded owned processes/resources. Never find and kill an arbitrary process by port or executable name. |

We can keep disposable configuration and state while sharing installed tooling
and readonly dependencies. Upstream AIUI source work also needs ownership: two
agents editing the same upstream checkout are not isolated just because their
app ports differ. Use an explicit checkout override/link when that happens;
do not overwrite another agent's link or upstream changes.

## Restart boundaries are separate

Source UI changes should normally update through Vite, while application-owned
connections remain in their deliberate state owner. A full page reload can end
browser-local HP execution; HMR is not durable recovery. Backend changes may
require a backend restart and therefore a distinct disconnect/recovery path.

AIUI's Electron experiment separates a development supervisor from restartable
Electron main/preload/renderer processes. This lets main restart without also
restarting compute services. That pattern is worth reusing, but we must qualify
it with our actual coordinator/provider lifetimes. The packaged application may
have a different owner: Electron main, a host daemon, or an explicit choice.
Do not silently take the dev supervisor's semantics as the product policy.

The [recovery sketch](failure-recovery.md) still applies. Seamless survival is
optional; reported loss and history-based reconstruction are acceptable. The
dev stack should expose which boundary restarted so a failure is diagnosable.

## Browser automation and concurrent agents

Prefer the ordinary browser lane for most UI automation: it can run visibly
through the agent session's Chrome DevTools MCP or in headless Chromium for
repeatable checks. Target the reported instance URL and browser page explicitly.
Keep another developer's tabs, processes and active conversations intact.

`aibr` can select a project browser, temporary browser or a profile with headless
settings. Its guide warns that agents sharing a profile share browser state.
Use that mechanism deliberately rather than adding global MCP registrations or
silently controlling the user's everyday browser.

Electron-specific behavior still needs real Electron validation. Its hidden
mode uses invisible windows; on the tested Mac it still requires a GUI session.
A successful headless browser test does not prove native dialogs, tray behavior,
preload IPC, desktop capture or the packaged app works.

## Qualification before making this the everyday workflow

1. Launch two real dev instances with separate ports/profile/state/output paths;
   prove that changes and shutdown in one do not affect the other's owned work.
2. Exercise frontend HMR, renderer reload and coordinator restart separately;
   record which connections, drafts, jobs and browser-local agents survive.
3. Drive the same browser frontend through the session MCP and headless tests.
4. If Electron is selected, repeat the relevant interaction with the same
   frontend and qualify main/preload restart and a concrete desktop operation.
5. Test a packaged artifact separately from development: bundled runtimes,
   endpoint configuration and cleanup, with signing/distribution decisions
   deferred until a real delivery target is chosen.

These are future checks, not claims about the current mock preview. Root package
release/version rules remain unchanged; no daemon installation, signing or
publication is authorized by adding this entry.

## AIUI references inspected

The local `.dev/aiui` checkout is authoritative. Relevant paths are:

- `docs/application-patterns/README.md`: browser/custom-service and Electron
  patterns, deliberate browser selection and concurrent-instance principles.
- `experiments/dev-stack/README.md`: one-command readiness, dynamic endpoints,
  service adapters and owned shutdown.
- `experiments/electron-stack/README.md`: browser-only, portable/desktop/hidden
  Electron modes, temporary instance state, restart boundaries and packaging.
- `packages/aibr/README.md`: MCP-connected browser selection and shared versus
  isolated profiles.
- `packages/aiui-build-config/docs/source-first-workspaces.md`: source exports,
  linked dependencies and separate qualification of source/HMR versus packages.

These references were read, not rerun here. Their own tool versions, npm
lockfiles, gateway policies and platform claims are not automatically adopted.
Preserve this repo's pnpm/uv workspaces and trusted-operator defaults, and adapt
only the measured lifecycle/routing pieces needed by the chosen slice.
