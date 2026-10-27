# Claude launcher delivery plan

The [specification](../specs/claude-launcher.md) records the implemented baseline
and the 25 October revision under investigation. The upcoming architecture will
use [068's evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
for multiple clients and launcher-owned process lifetime; the production package
has not yet adopted that path.
This plan tracks the first Python implementation and its acceptance gates. Browser
and Node are the supported live clients; Python exposes management and launch APIs.

**Checkpoint, 2026-10-13:** core macOS qualification is complete for the scope below.
The package remains unreleased and the prepared Linux job has not run. See the
[handoff](../claude-handoff.md) for the important next steps when work resumes.

| Work | Acceptance | State |
| --- | --- | --- |
| Profile/authentication | Independent native config roots, API-key references, explicit login reuse, native profile login; no ordinary developer-state writes | Implemented; existing-login reuse, dedicated native login and genuine API-key inference passed |
| Profile customization isolation | Native agents, commands, skills, instructions, plugins and MCP configuration remain profile-scoped; selected project configuration is shared | Passed real native/Node fixture tests; managed policy and authenticated syncing remain outside qualification |
| Runtime and relay | Lazy native spawn, concurrent workers per profile, raw SDK traffic, disconnect/stop/shutdown cleanup | Implemented; real subprocess/network tests pass |
| Saved conversations | Official Python SDK list/read/rename/fork in fixed profile environments, explicit resume into a new worker | Implemented; profile/helper tests and live Node/browser fork/resume pass |
| User interfaces | Mountable Typer CLI, async library, optional FastAPI adapter, browser profile/history/chat workflow and Node example | CLI/HTTP tests, Node example and actual Chrome core workflow pass; UI permission controls and mid-turn interruption remain unqualified |
| Observation | Independent recording/usage processors, backlog and loss reporting, optional generic MITM composition | Implemented; capture failure tests and live upstream MITM check pass |
| Compatibility | Real native subprocess/network tests, actual official browser/Node clients and bounded Haiku usage ledger | Node/native pass, including 4 concurrent clients over 2 rounds; Chrome/API-key single-turn and concurrent/fork/resume probes pass |
| Linux qualification | Reproducible credential-free native/Node concurrency and profile-isolation checks in CI | Script passed locally; pinned Linux CI job prepared, not yet run |
| Packaging | Workspace lock, package build, CLI imports, lint, tests and strict documentation build | Passed locally; all 73 Claude tests pass on Python 3.14 and against the built wheel on Python 3.12 |

The operator completed dedicated-profile browser authentication; native auth status
and a live Node SDK turn then passed. Credential refresh remains unqualified.

Deferred: live Python clients, Bedrock/federation adapters, borrowed-token renewal,
shared-worker multiple controllers, native terminal attachment, Remote Control,
durable execution recovery and Hostfork deployment qualification. Preserve explicit
boundaries so these can be evaluated independently.
