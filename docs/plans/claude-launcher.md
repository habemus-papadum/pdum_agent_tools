# Claude launcher delivery plan

The [specification](../specs/claude-launcher.md) records the agreed architecture.
This plan tracks the first Python implementation and its acceptance gates. Browser
and Node are the supported live clients; Python exposes management and launch APIs.

| Work | Acceptance | State |
| --- | --- | --- |
| Profile/authentication | Independent native config roots, API-key references, explicit login reuse, native profile login; no ordinary developer-state writes | Implemented; dedicated native login and live use passed; genuine API-key inference pending |
| Runtime and relay | Lazy native spawn, concurrent workers per profile, raw SDK traffic, disconnect/stop/shutdown cleanup | Implemented; real subprocess/network tests pass |
| Saved conversations | Official Python SDK list/read/rename/fork in fixed profile environments, explicit resume into a new worker | Implemented; profile/helper tests and live Node fork/resume pass; actual browser pending |
| User interfaces | Mountable Typer CLI, async library, optional FastAPI adapter, small browser/Node management client example | Implemented; CLI/HTTP tests and Node example pass |
| Observation | Independent recording/usage processors, backlog and loss reporting, optional generic MITM composition | Implemented; capture failure tests and live upstream MITM check pass |
| Compatibility | Real native subprocess/network tests, actual official browser/Node clients and bounded Haiku usage ledger | Node/native pass; actual browser unavailable this session |
| Packaging | Workspace lock, package build, CLI imports, lint, tests and strict documentation build | Passed locally; all 69 Claude tests pass on Python 3.14 and against the built wheel on Python 3.12 |

The operator completed dedicated-profile browser authentication; native auth status
and a live Node SDK turn then passed. Credential refresh remains unqualified.

Deferred: live Python clients, Bedrock/federation adapters, borrowed-token renewal,
shared-worker multiple controllers, native terminal attachment, Remote Control,
durable execution recovery and Hostfork deployment qualification. Preserve explicit
boundaries so these can be evaluated independently.
