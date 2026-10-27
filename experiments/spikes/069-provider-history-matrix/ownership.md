# Ownership, storage and failure

Five identities should survive the design: **profile, saved conversation, running
agent, client connection and process/Worker owner**. A task or background job can
add another owner. Their lifetimes are related, but not interchangeable.
The [evidence register](README.md) defines status labels and version boundaries.

**070 update:** the original tables retain the 039–052 baseline. [070](../../docs/spikes/070-hp-backend-parity.md)
now demonstrates saved context across Node process exit and browser Worker/page
reload, with interchangeable filesystem and IndexedDB adapters. The same archive
and restore code serves both hosts. It restores conversation context into a new
owner, not live jobs or queued input delivery; seamless owner recovery and a
cross-tab execution host remain unqualified.

| Event | Codex | Claude current integration / new direction | HP Node | HP browser |
| --- | --- | --- | --- | --- |
| One client detaches | **Observed:** other subscribed clients remain; native work continues. [028][joins] | **Current production observed:** SDK disconnect ends its worker. **Observed 068:** client detach leaves owned process and journal active. [065][lifecycle], [068][raw] | **Local-tested:** detach removes observer and its waits, not runtime/jobs. [052][jobs] | Same portable behavior while the owning execution host remains alive. |
| Last client leaves | **Observed:** active work/pending requests retained; ordinary idle unload later requires zero subscribers and non-active state. [056][inactive], [057][terminal] | **Observed 068:** real tool turn completed with zero clients; stdout remained recorded. No idle reaping policy inferred. [068][raw] | **Source/local-tested:** no subscriber-count idle eviction in prototype. Explicit runtime disposal is separate. [runtime][hp-source] | Same core, but closing the page that owns a dedicated Worker also removes the execution host. A connection detach is not page/Worker survival. |
| Idle/unloaded | **Observed:** native Ready/Inactive reflects loaded runtime, not objective completion/archive. Native default delay 1,800s in 0.163.0; zero means immediately eligible. [056][inactive] | **Unqualified:** no equivalent native idle timer established; don't map Codex timer onto Claude. | **Gap/design:** no production idle-retention policy selected. | Same open policy, plus host-specific suspension/lifetime limits. |
| Interrupt turn | **Observed:** selected tool PID survived interrupted turn; explicit runtime end later reaped it. [065][lifecycle] | **Observed current:** selected Bash tool terminated; worker stayed until disconnect/end. Not every tool qualified. [065][lifecycle] | **Observed/local-tested:** turn/wait cancellation differs from job cancellation; uncooperative callback can keep running. [050][parallel], [051][background] | Same async semantics; CPU work needs a host capable of termination, not only an AbortSignal. |
| Explicit runtime/owner shutdown | **Observed:** selected owned processes reaped; ending one did not stop another. [065][lifecycle] | **Observed current:** graceful owner cleanup reaped workers. **Observed 068 browser check:** explicit stop emitted exit marker; subsequent reap removed journal. [068][raw] | **Local-tested:** dispose interrupts turns and requests own-job cancellation; separate shell adapter still needs close. [052][jobs] | Same core disposal; Worker termination has its own host behavior and cannot preserve arbitrary callbacks. |
| Owner crashes | **Observed:** Codex PIDs survived isolated SIGKILL but public relay vanished; native socket success did not establish managed recovery. [065][lifecycle] | **Observed current:** native worker exited when owner was killed. **Unqualified 068:** preserving process after client disconnect does not establish owner-crash survival. | **Unqualified:** no durable runtime/job recovery; native process adapter crash semantics not established. | **Unqualified:** browser/page/Worker loss recovery not implemented. Stored snapshots would still need explicit restoration. |
| Runtime ends; read conversation later | **Observed:** native history remains readable. [064][continuation] | **Observed:** native helper history remains after SDK worker exit. 068 explicitly stops/reaps its process journal separately. [064][continuation], [068][raw] | **Observed:** exported journal can reconstruct data offline. Automatic durable persistence not implemented. [040][hp-live] | Same pure reconstruction if host retained/exported the data. Browser reload persistence not qualified. |
| Restore files/terminals/jobs | **Gap by operation:** native resume/fork does not recreate old terminal execution or undo files. [057][terminal], [029][fork] | **Gap by operation:** saved context is not process/callback recovery. | **Gap:** snapshots/forks do not clone execution; new job scheduling is an explicit action. [052][jobs] | Same; serialized state cannot recover a live Promise or old browser resources. |

The general rule is to report what survived: data, process, endpoint, ownership,
or none of them. A PID and a transcript do not prove that a client can reconnect.
An archived conversation is not synonymous with a stopped server. Previous-owner
metadata should remain unowned evidence unless an explicit, qualified adoption
mechanism exists. These distinctions apply RC-01/02/04/06/07/08/12/13.

## Profiles and authentication remain their own owners

| Boundary | Codex | Claude | HP Node/browser |
| --- | --- | --- | --- |
| Profile versus live session | **Observed:** one native home can contain many conversations/processes; launcher records ownership separately. Lab continuations preserve profile/cwd scope. [064][continuation] | **Observed:** multiple independent workers share profile/auth while keeping conversation identity separate. Native user configuration can be isolated with selected setting sources. [016][claude-profile] | **Design:** portable core accepts connections/tools; no production profile-management API yet. Do not borrow native profile meaning by naming a Worker “profile.” |
| Read history versus authenticate for inference | **Observed:** isolated native reads need no model credentials and load no runtime. [058][native-history] | **Observed:** official history helpers run without model authentication. Positive native login status alone does not establish valid model access. [058][native-history], [066][claude-token] | **Observed:** pure snapshot replay creates no connector; live connection authentication is application-owned. [040][hp-live] |
| Credential delivery | **Observed:** recent lab live checks use explicitly borrowed native authentication in isolated homes. Broader strategies belong to launcher configuration. [067][live-study] | **Observed:** dedicated native login, existing-login reuse and API-key paths qualified in production launcher; supplied setup-token works in 066 and raw 068. Updating its reference affects new allocations, not the existing process environment. Refresh/revocation remains unqualified. [validation][claude-validation], [066][claude-token], [068][raw] | **Observed:** injectable connection factory; real browser Worker uses credential-attaching dev relay. Federation/renewal is a host integration choice, not a qualified HP feature from these runs. [038][hp-connection], [040][hp-live] |

The new Claude attachment service does not require distributing model credentials
to each browser. Its native process already owns the supplied authentication.
Changes to credential assignment and refresh should retain their explicit scope;
client reconnection is not credential renewal. This carries RC-11 into the design
without adding an authentication framework to the replay server.

## HP storage and hosting boundary

The current HP core has in-memory threads, model context, usage records, a
snapshot/notification journal and a job registry. Its pure `replay()` returns
saved thread data; it does not instantiate a runtime. The protocol has no
`thread/resume`. The tested browser owns execution inside a dedicated Worker;
Node uses the same core with host-supplied adapters. [039][hp], [040][hp-live],
[runtime source][hp-source], [protocol source][hp-protocol].

The architecture can preserve that separation:

| Concern | Proposed common boundary | Node host option | Browser host option |
| --- | --- | --- | --- |
| Conversation/context storage | Store/read versioned data independently of active execution; preserve native provider artifacts. | Files or database behind an adapter. | IndexedDB/OPFS or application-provided storage. No browser adapter is qualified yet. |
| Running execution | One owner manages active turns, children, jobs and tools. | Application process, optionally hosted by the unified coordinator. | Page/Worker initially. A shared host for cross-tab clients needs its own lifecycle study. |
| Client transport | Native-shaped envelope subset and explicit HP extensions. | MessagePort or network adapter. | MessagePort; remote network connection when execution lives elsewhere. |
| Restoration | Explicitly restore saved context into a new execution owner; do not replay side effects. | Same portable restore logic with host rebinding. | Same logic, with browser credentials/tools/storage rebound by application. |
| Local tools | Tool implementation supplied by host. | Existing shell/files/MCP adapters. | Application functions, remote tool proxy or future CPU-Worker/cell adapters. |

070 implements the proposed storage/restore separation as research code, without
selecting the production storage engine or implementing a cross-tab daemon.
Persistent storage does not make a dedicated Worker survive
page destruction. Conversely, a browser frontend can leave safely when its
actual execution owner is a separately hosted Node process. The UI should expose
that ownership instead of presenting a generic “browser agent” lifetime.

## Decisions to ask when they become necessary

| Needed before | Smallest unresolved question |
| --- | --- |
| First durable HP session implementation | Which application owns storage, and do we first restore only completed/idle checkpoints? A storage engine choice alone does not settle restoration. |
| Promising HP cross-tab attachment | Is one tab allowed to own execution, or must execution live in a separately managed browser/Node host? Qualify that host's lifecycle. |
| Shipping Claude replay | What should the client display after a real journal/storage gap or ambiguous native response? Keep the server mechanical; do not silently fabricate completeness. |
| Promising work after owner failure | Is history-based relaunch sufficient for this deployment, or is a surviving endpoint required? Existing direction accepts pragmatic loss and explicit relaunch. |
| Cross-host continuation | What credentials, files and tool environment must the destination supply? Conversation transfer alone is not environment transfer. |

None requires a broad new mock round before the backend proposal. The first
implementation can state its supported host/lifetime boundary and leave these
capabilities explicit rather than simulating seamless recovery.

[joins]: ../../docs/spikes/028-codex-joins.md
[fork]: ../../docs/spikes/029-codex-forks.md
[inactive]: ../../docs/spikes/056-codex-inactive-lifecycle.md
[terminal]: ../../docs/spikes/057-launcher-inactive-turns.md
[lifecycle]: ../../docs/spikes/065-session-lifecycle.md
[continuation]: ../../docs/spikes/064-history-continuation.md
[raw]: ../../docs/spikes/068-claude-feed-replay.md
[hp]: ../../docs/spikes/039-hp-agent-runtime.md
[hp-live]: ../../docs/spikes/040-hp-integration.md
[parallel]: ../../docs/spikes/050-hp-parallel-tools.md
[background]: ../../docs/spikes/051-hp-background-jobs.md
[jobs]: ../../docs/spikes/052-hp-work-integration.md
[hp-source]: ../039-hp-agent-runtime/src/runtime.ts
[hp-protocol]: ../039-hp-agent-runtime/src/protocol.ts
[claude-profile]: ../../docs/spikes/016-claude-client-sessions.md
[native-history]: ../../docs/spikes/058-native-history-access.md
[claude-token]: ../../docs/spikes/066-claude-setup-token.md
[claude-validation]: ../../../docs/claude-validation.md
[live-study]: ../../docs/spikes/067-live-session-workspace.md
[hp-connection]: ../../docs/spikes/038-hp-sdk-fit.md
