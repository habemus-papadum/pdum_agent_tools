# Claude launcher checkpoint and follow-up

**Checkpoint: 2026-10-13.** The Claude investigation has reached a useful stopping
point: a working Python launcher with real browser and Node SDK qualification on
macOS. The package is **unreleased**. The latest qualification, browser UI and CI
changes are local at this checkpoint; the new Linux CI job has not run. The
[qualification report](claude-validation.md) owns the detailed evidence and cost
ledger; the [delivery plan](plans/claude-launcher.md) tracks implementation status.

## Architecture to retain

The official browser or Node SDK owns the live query, including callbacks and
streaming. Python owns profiles, native worker processes and a raw byte relay.
Saved-history operations use official Python SDK helpers through a separate
management API. There is no second conversation query in the manager.

A profile can serve multiple independent workers. Client disconnect ends its
worker; saved history can be read, forked or explicitly resumed in a new worker.
Resume restores saved context, not the former process or pending callbacks.
Keep native configuration native and avoid private recovery formats or transcript
surgery. The [specification](specs/claude-launcher.md) records these decisions.

## Completed at this checkpoint

- Live use passed for existing-login reuse, dedicated-profile native login and
  genuine API-key authentication. Credentials stay on the host.
- Official Node and actual Chrome clients passed streaming, prompt hooks,
  concurrent workers, independent disconnect, saved history and fork/resume recall.
  The browser page also passed its basic profile/history/chat controls and tab-close
  cleanup. The SDK browser bundle needs the documented small `process` shim.
- Native fixtures verified profile-specific agents, commands, skills, instructions,
  plugins and MCP configuration. Selected project configuration is shared;
  profiles do not isolate filesystems or machine-managed policy.
- The 73-test Claude suite passed on Python 3.14 and against a built wheel on
  Python 3.12. Local builds, lint and strict documentation checks passed. These
  results are separate from the pending Linux CI qualification.
- The Python-launcher ledger contains 15 paid Haiku turns, including the failed
  browser fixture attempt, totalling **USD 0.00444142** in SDK estimates. Historical
  TypeScript spike costs are separate. Neither ledger is an inspected bill or a
  measure of orchestration-agent costs. Browser test workers and their manager
  were stopped after qualification.

## Pick up next

| Priority | Work | Evidence needed |
| --- | --- | --- |
| 1 | Run the prepared Linux `claude-clients` CI job after the changes are reviewed and pushed. | Real pinned native Claude and official Node SDK pass repeated concurrency, profile discovery and cleanup on Linux. The job uses no provider credentials or model prompts. Qualify Hostfork/cloud composition separately before relying on it. |
| 2 | Exercise the remaining browser controls against the Python host. | Interrupt an active turn; exercise **Allow once** and **Deny** with an explicitly permission-enabled test worker; close while a callback is pending and confirm cleanup. Existing SDK interrupt-control and prompt-hook results do not establish these UI paths. |
| 3 | Qualify authentication renewal before longer-running shared-profile deployments. | Observe native renewal and simultaneous workers sharing one dedicated profile. Document expired borrowed-token behavior; use native/public provider mechanisms. Initial login success does not establish refresh behavior. |

When upgrading native Claude or either SDK, repeat the existing credential-free
checks and small live Node/browser flows. Recheck launch-option mapping, browser
transport/shim requirements and saved-history helpers against the new versions.
Use Haiku, bound experiment turns/time/retries, retain failed attempts, and subtract
previously observed cumulative cost on resume.

Optional later work: desktop/phone Remote Control through supported native flows;
coordinated multiple controllers or viewers for one worker; Bedrock/federation
authentication; richer browser forms and attachments; selective profile imports.
These need separate scope decisions. Native terminal attachment, live Python
conversation clients, durable execution recovery and general cleanup after abrupt
manager death remain outside the qualified implementation. Further tracing of
private Claude internals is not a prerequisite to resume work.

## Resume locally

Use the [operator guide](claude.md) for profile/login and launcher commands and
`examples/claude-client/README.md` for browser and Node probes. From the repository
root, after installing the selected native Claude executable:

```sh
uv sync --frozen --all-packages --all-extras
pnpm --dir examples/claude-client install --frozen-lockfile
pnpm --dir examples/claude-client build
uv run --frozen pytest packages/claude-launcher/tests -m 'not live'
uv run --frozen python scripts/check_claude_clients.py --clients 4 --rounds 2 --timeout 120
```

These checks submit no model prompts. Live probes require an explicitly selected,
usable host credential. Local evidence and the temporary credential's expiry note
are under ignored `artifacts/claude-launcher-validation/`; they are not distributed
with the repository. Do not assume those credentials or artifacts survive a
checkout or remain valid when work resumes.

Publication remains a separate maintainer action through the
[release workflow](development.md#releases), which releases each package on its
own. The first three packages were published as 0.1.0; `habemus-papadum-claude-launcher`
has not released and carries `0.0.0+dev` until its first release.
