# Backend libraries and host ownership

**Proposal for review, 26 October 2026.** This document describes the backend
portion of the full system. Existing packages remain useful libraries; one new
`pdum.orchestrator` package composes them. A foreground command is the first host.
An operating-system service can host that same application later. There is no
separate Codex daemon, Claude daemon or universal server-side conversation loop.

The accepted [host-coordinator direction](../components/21-host-coordinator.md),
[trusted-operation principles](../../../design-principles.md) and
[runtime contracts](../../../runtime-contracts.md) constrain this proposal.
The implementation-status statements below refer to the repository today, not
to functionality that this design has already added.

## Library map

| Library | Main components | Functionality and design rule | Present state / work to add |
| --- | --- | --- | --- |
| **`pdum.orchestrator`** — new Python host composition | Provider registry, process ownership, management operations, connection descriptions, operation records, observation routing, peer-host directory, ingestion jobs; Typer/FastAPI adapters | One management entry point for a host. Call libraries rather than parse their CLI output. Preserve provider-specific settings, identities and lifetime rules. | S0 instance identity/readiness/status/stop and inert CLI/HTTP adapters are implemented. Provider composition, remote aggregation, daemon hosting and stronger recovery remain future work. |
| **`pdum.codex_launcher`** — existing Python provider library | Native-home profiles, configuration/authentication, launch/readiness, run records, inspection/stop, native relay, observation hooks | Launch native app-servers and return their endpoints. Preserve native TOML and unknown settings; per-run overrides do not edit profile defaults. | Implemented local foundation. Add the coordinator adapter and qualified native-history access where needed. Keep native subscription/unload behavior visible. |
| **`pdum.claude_launcher`** — existing Python provider library | Profiles/authentication, native process owner, stdio transport, multi-client replay journal, official history-helper lifecycle | Own the process and byte transport. Forward client input unchanged; native Claude supplies acceptance and execution outcomes. Clients own SDK queries and shared-question interpretation. | Profiles, client-owned worker relay and history helpers exist. Process lifetime independent of attachment and full feed replay are qualified research in 068/071 and must be extracted into this library. |
| **`pdum.agent_history`** — existing Python ingestion library | `history.yaml`, Codex/Claude readers, source fingerprints, staging/publication, schema/provenance, incremental ledger, local/MotherDuck targets | Read local native storage and publish analytical data through the existing contract. Keep one ingestion configuration owner and source-scoped identities. | Implemented for Codex/Claude. Add an HP export source adapter and address measured invariant/query gaps; do not create another ingestor or silently change the schema. |
| **`pdum.mitm`** — existing optional Python transport library | Sidecar lifecycle, proxy environment, scoped CA/configuration, generic processors and capture controls | Optional upstream HTTP/WebSocket observation. Remain independent of agents, Codex and the orchestrator. | Implemented. The coordinator selects it through provider launch options; no mandatory interception or global CA/proxy changes. |
| **`pdum.hostfork`** — existing optional Python environment library | Environment planning, host/private trees, execution, recorded identity, lifetime, cleanup and recovery inspection | Supply an explicitly selected execution environment. Reopening its management is not restoration of old process pipes or conversation state. | Linux implementation and qualified research exist. Integration with orchestrated provider launch is later work, not a prerequisite for local sessions. |

These are package boundaries, not a requirement to create a package for every
component listed in the second column. The coordinator's provider adapters,
operation ledger and HTTP routes begin as modules in that package. Existing
launchers remain usable without installing the orchestrator or Node.

The TypeScript **`hp-agent`** library is a separate execution implementation.
Its Node host runs as an application-owned child selected by the coordinator;
its browser host is owned by the browser application. Python must not reproduce
the HP agent loop, archive codec or restore logic. The TypeScript
**`orchestrator-client`** handles management and endpoint discovery, while
`codex-client`, `claude-client` and `hp-agent/client` handle session interaction.
The management client need not import all provider SDKs.

## One management path, distinct session paths

The coordinator owns host identity, configured profile references, current run
ownership, provider preparation, native login operations and explicit shutdown.
It can aggregate another host's inventory without acquiring ownership of that
host's processes. A selected remote host performs its own launches and resolves
its own profile paths and credentials.

After launch or discovery of an owned run, return a **connection description**.
The browser or Node application selects the provider client and attaches directly
to the described endpoint where routing permits. An explicit relay route is also
valid. A different URL does not prove independent failure survival: the endpoint
can still depend on the coordinator's pipes, relay or selected proxy.

Illustrative fields, not a final wire schema:

```typescript
type ConnectionDescription = {
  hostId: string;
  provider: "codex" | "claude" | "hp";
  runId: string;
  ownerInstanceId: string;
  profileRef?: { hostId: string; provider: string; id: string };
  recipeRef?: { kind: "hp-recipe"; id: string };
  endpoint: { kind: string; url: string; route: "direct" | "relay" };
  protocol: { version: string; capabilities: string[] };
  conversationRef?: { id: string; cwd?: string };
  lifetime: {
    owner: "coordinator" | "node-host";
    attachment: string;
    recovery: string;
  };
};
```

The native conversation ID may not exist at launch. A Codex app-server can host
several threads, so stopping that run differs from interrupting one turn or
unloading one thread. A Claude worker has a native conversation identity and its
own feed. HP has its own runtime, thread, child and job identities. Keep these
relationships rather than pretending every process, conversation and client is
one interchangeable “session.” Evidence: RC-01/03/08/12/13/14, [064][s064],
[065][s065] and [069][s069].

The provider-specific descriptor requires a native `profileRef` for a managed
Codex/Claude launch. HP instead uses a launch recipe owned by `hp-agent`'s host
adapter: runtime options, tool/configuration references, credential factory and
storage adapter. Its Node host validates that recipe; the browser app supplies
its corresponding local bindings. The app/coordinator may store named recipe
references, but must not apply native-home copy/edit semantics to HP or invent a
universal configuration schema. This sketch leaves either reference optional
only because it abbreviates the final provider-discriminated descriptor.

### Management operations

The following operation groups identify responsibility; they are not a replacement
schema for every provider command:

| Group | Representative operations | Owner and effect |
| --- | --- | --- |
| Host/inventory | Describe capabilities; list configured peers, profiles and known runs; refresh an observation | Coordinator metadata plus provider inspection. Keep owned, externally observed and previous-owner records distinct. |
| Profiles | List/inspect; preview creation from native source or scratch; commit creation/edit; inspect native settings | Existing launcher profile/config libraries. Preserve unknown native fields and separate preview from mutation. |
| Authentication | Inspect source/status; run native profile login; assign an environment/file credential reference; inspect login-operation progress | Provider authentication adapter on the selected host. Configuration, credential acquisition and model-access validation are distinct. |
| Runtime | Launch; describe endpoint; stop one recorded run; stop an explicitly selected set | Provider library owns actual processes. Return the affected run identities and observed outcome. No implicit stop-all across peer hosts. |
| History access | Obtain a native catalogue/read capability; rename or fork where supported; prepare explicit continuation | Provider-native history adapters. Reading does not resume or create a model turn. The client retains the provider's boundary kind and raw content. |
| Ingestion | Read/preview/save existing ingestion config; start sync; inspect progress/coverage; select a configured target | `pdum.agent_history`, run outside the management event loop. The UI configures `history.yaml`; it does not invent another ingestion configuration. |
| Observation | Inspect processors, backlog, errors and captured range; change explicitly supported capture settings | Existing launcher/MITM observation APIs, with derived summaries from shared TS calculations. Capture changes do not alter conversation meaning. |
| Host workspace | Resolve/read a referenced file; start a direct command, stream its output, write supported stdin and stop its owned process | Qualified provider operation when already available, or an explicit coordinator host adapter. A Claude file link must not require silently launching a Codex conversation. Direct commands have their own ownership, independent of model turns. |

Long operations such as login, ingestion and runtime startup need operation IDs,
progress and a terminal result. This is a small management-operation record, not
a general distributed workflow engine. Record a launch operation before dispatch
and relate it to the run it created. After a lost acknowledgement, inspect that
record and process evidence before repeating the launch. A record with an unknown
outcome is not exactly-once execution. Native prompt IDs and their retry semantics
remain provider-specific; the management API does not make conversation sends
idempotent.

FastAPI adapts these async library calls without becoming a second owner. Typer
commands call the same library and can be mounted alongside provider CLIs.
Importing either adapter starts no process and installs no signal handler. The
foreground entry point owns shutdown. Normal Python installation remains
independent of Node; enabling an HP Node host or TS analysis host adds that
specific runtime requirement.

The host workspace adapter starts as a coordinator module, not another general
remote-execution library. Reuse native Codex file/process operations where they
fit an already selected endpoint; otherwise use an owned host read/subprocess
adapter with the same target/provenance information. Source viewing is read-only
first. Streamed commands preserve stdout/stderr, stdin, final output and actual
exit state; pipes must not be labelled a PTY. A historical path can resolve to
current bytes without becoming historical content. Qualification of this adapter
and any PTY/resize extension belongs to O17's delivery slice.

## Provider ownership and changes

### Codex

Reuse the current native-home layout, `LaunchOptions`, `launch()` context,
`RunningAppServer`, per-run records, inspection and PID-aware stop. A profile is a
Codex home, and launcher metadata stays beneath its `.pdum/` directory. Several
processes can share that home; the coordinator must not add an exclusive profile
lease. Native config changes remain explicit edits; launch choices remain `-c`
overrides. The ordinary home remains available through the existing explicit
default-profile selection.

Codex controls loaded-thread retention through subscriptions and native idle
configuration. A loaded idle thread can own a terminal. Losing its last subscription
can eventually unload it and kill that terminal; a retained subscription keeps
ordinary idle unloading from occurring. A background tool alone is not a keepalive.
The coordinator must not subscribe/resume every thread merely to paint an overview.
Initial inventory uses process metadata, native inspection and history reconciliation;
derived live coverage states when no subscribed connection observed the stream.

**26 October decision:** do not retain a host subscription for keepalive or
observation. Normal live clients still subscribe when joining. Offer a longer
unload interval in the new-session/launch flow, using the native
`thread_unload_delay_secs` launch override. RC-06 establishes that it is captured
at app-server startup and applies to its threads, not individually per conversation.
When reusing an existing server, show its inherited setting; changing it requires
an explicitly chosen new/restarted server, not a hidden restart or global-config
edit. The user has not selected a numerical longer default. Native unloading may
still end managed background work. RC-02/04/05/06/07 and [056/057][s057] supply the boundary.

### Claude

Keep `Profile`, authentication environment construction and official history
helpers. Replace the current one-controller `waiting → connected → stopped`
relay lifetime with independent launch, process ownership and attachments.
The native stdin stays open with zero clients. Each incoming transport write is
forwarded unchanged. The host serializes writes mechanically; it does not parse
user intent, validate native commands, manufacture acceptance or choose a
controlling client.

The process feed has ordered raw records and explicit replay/live markers. Record
stdin, stdout and stderr with their directions; attachment replays/fans out stdout.
Recorded stdin is diagnostic evidence, not a successful-send echo. Full payloads
are retained initially. The storage path under the profile and reclaim operation
belong to the launcher; `.aiui/running/...` was the spike's provisional location,
not a new immutable public layout. A journal can be reclaimed after its process
ends; native saved history remains available for subsequent continuation.

Prefer official SDK reuse through `claude-client`'s replay/reconnection layer,
as qualified in [071][s071]. That client keeps historical controls passive,
constructs replacement SDK queries after loss and reconciles shared questions from
native responses. The Python host never owns a second query. Native malformed
input can terminate the worker; report process exit and uncertain outcomes rather
than adding a server semantic validator. SDK-hosted hooks/MCP functions still need
explicit client execution ownership. RC-13 and [068][s068] cover the process/feed
mechanics; 071 does not qualify every callback or browser packaging choice.
Do not elect a primary observer preemptively. If a particular client-executed
callback cannot work without a designated owner, bring that concrete case back
for discussion before adding a selection layer.

### HP Node and browser

The coordinator starts an HP Node host process and owns its process identity,
endpoint and graceful shutdown. The TypeScript host constructs the runtime,
provider connector, tools and storage adapter. It exposes HP session operations
and observations. It is an execution child of the application, not another
machine-wide provider daemon. A browser-owned HP runtime is outside that remote
process registry; its application can expose local inventory alongside remote
runs and optionally export analytical data.

HP's archive codec, list/read, checkpoint selection, resume and fork stay in
portable TypeScript. To browse an offline HP archive through host management,
call an HP Node history helper that creates **no connector or execution runtime**,
or use the already-running HP host's passive history service. Python must not
duplicate that codec to satisfy a generic “local readers are Python” convention:
Codex/Claude native-file readers are Python integrations; HP owns a portable
format with proven Node/browser semantics. The existing Python ingestor consumes
HP's versioned row export through its writer.

Filesystem and browser stores implement the same async storage boundary. Browser
storage is not required to be a filesystem or localStorage. Credentials, tool
implementations and dynamic prompt callbacks are supplied again by the new host.
Recorded context is not a suspended Promise, terminal or mailbox. RC-14 and
[070][s070] qualify this separation. Prompt preparation remains a portable host
concern; this backend does not introduce a mandatory Python prompt service.

## Configuration and authentication flows

The coordinator needs a small composition configuration: its instance/state
location, bind/advertise addresses, provider profile roots/references, selected
processors, peer coordinator addresses and the location of the ingestor's own
configuration. Those fields route existing capabilities. They must not duplicate
native Codex TOML, Claude settings or every `history.yaml` source/target field.
Each isolated development instance selects separate writable state, ports and
test profiles before starting owned resources.

Profile setup follows one flow across the app while each provider owns the actual
configuration: select a host/provider, choose a native base or scratch, preview the
native changes, choose an authentication strategy, commit the profile, then run
the selected native login or credential-assignment operation. Editing a base does
not create an implied inheritance relationship with earlier copies. Raw native
editing remains available where the provider supports it. [060][s060], [063][s063]
and the existing [profile guide](../../../profiles.md) supply the operation map.

Launch values derive from the UI context: a selected host/project/directory is
the starting point, with visible provenance and explicit override. A conversation's
working model/effort/tier may carry forward to its next turn without writing saved
profile/application defaults. Persisting defaults is a separate explicit action.
For workspace isolation, accept an existing worktree or a requested native/existing
worktree provisioner after verifying that exact provider launch path. Record the
resolved cwd and owner; do not build a Git worktree manager as a prerequisite or
conflate conversation forks with filesystem worktrees.

| Strategy | Initial treatment |
| --- | --- |
| Dedicated native login | Use the existing profile-scoped Codex/Claude login functions. Return native login instructions/progress to the chosen frontend; the operation runs on the profile's host. |
| Existing-login reuse | Keep the already-authorized convenient explicit borrowing path. Resolve it on the host, preserve the source and state that borrowed-token refresh is not managed. |
| API key | Reference a host environment/credential source through the owning launcher configuration. Assignment and a successful live model request are different facts. |
| Claude setup token | Add a first-class credential-reference path to the launcher from 066's existing environment-injection proof. Support operator-assisted creation and reference assignment; do not promise renewal, revocation behavior or an exact observed lifetime from the short probe. |
| Federation / Bedrock / other providers | Preserve existing native fields and adapter seams. Codex's AWS helper/config support already exists, while actual exchange/renewal remains unqualified. Additional Claude provider flows are later implementations, not invented generic auth configuration. |
| Browser HP credentials | The hosting application supplies its connection/credential factory, including its established dev/federation pattern. Remote-launcher credential assumptions do not define browser-local HP authentication. |

For native process clients, model credentials stay with the selected host/process;
each attached browser does not need another model login. This is different from
authenticating access to a coordinator: the default application runs on the
operator's trusted network, with no mandatory client grants, expiry or login layer.
Native provider permission questions remain supported when selected even though
the default execution mode has sandbox/approvals off.

Expose credential source/presence, last native status, last successful model-access
observation and their timestamps separately. A positive status is not verified
model entitlement. Changing a credential reference applies to new allocations;
it does not silently replace an existing process's environment. The user selected
simple independent behavior: do not coordinate reauthentication across sessions,
drain/pause other work, hold credential leases or add busy-profile guards. Let
native refresh/failure behavior occur and expose its useful messages. A selected
credential operation is not blocked because other sessions share that profile.
Do not automatically kill work or charge for a model check merely because a profile
was edited. More elaborate coordination can follow experience, not speculation.
RC-11 and [066][s066] remain the direct evidence.

## Observation, analysis and the four stores

| Data | Purpose and owner | Retention meaning |
| --- | --- | --- |
| Native provider history / HP archive | Passive conversation inspection and explicit continuation; provider reader or portable HP history code | Independent of the current client or optional development capture. Not a complete live-event archive or execution checkpoint. |
| Claude running-process journal | Attachment/replay for one owned process; Claude launcher | Functional transport state. May end with the process; does not establish recovery of old pipes after coordinator loss. |
| Optional debug capture | Reproduce a UI/projection problem with raw records, source identity and selected state; application/observer tooling | May be on by default during development. Separate from normal history and ingested analytics; no universal requirement to archive every live-only detail forever. |
| Analytical database | Statistics, search, invariants and cross-session queries; existing ingestor and TypeScript analysis | Local DuckDB or configured MotherDuck target. Missing/stale data must not erase known runtime inventory. |

Launcher taps copy/enqueue without waiting for parsing, disk recording, queries or
export. Show capture/processor backlog, failures and any real gaps. No initial
payload caps, truncation thresholds or run quotas are part of this design.
Selected MITM capture follows its generic sidecar lifecycle and existing capture
controls; a failed optional recorder differs from failure of a proxy required by
the live connection.

Shared meaning belongs in TypeScript: provider projection subpaths convert native
records into `agent-core` facts; `agent-history/analysis` computes cost, coverage
and advisory health. The same functions run in a client, historical tool or host
processor. Python handles process/transport/storage facts and does not implement
a second cost/context interpretation. Existing small Python usage observers remain
implemented evidence; they are not the authority for new shared calculations.

For headless rich summaries, the proposed host adapter is **one optional Node
analysis process per coordinator**, running the shared modules for selected
processors. It receives copied observations and returns derived snapshots. It
does not open a provider SDK query or subscribe to a conversation just to analyze
input. The first thin slice can work with process metadata plus browser-side
analysis; the shared analysis host follows when the overview must retain rich
derived state without a browser. This is not one process per plugin. The passive
HP history/export tasks can reuse this Node host when selected, with their own
operation records and errors.

Analysis unavailability makes derived summaries stale while provider forwarding
continues. Keep raw/source identity, provider/reader/adapter versions, process
epoch, direction, native IDs and receipt ordering available so interpretations can
be revised. Duplicate client observations and inherited fork context must not
create new usage. Cost is a dated API-equivalent calculation over available
usage, not an invoice; missing context/usage remains unknown. RC-07/09/10/14 and
[061][s061], [069][s069], [070][s070] identify the existing traps.

The ingestor continues to own staging, fingerprints, source-scoped replacement
and publication. Run its synchronous work outside the async management loop.
For a local database, use **one coordinator-owned Python database execution
path** and serialize ingestion/publication with analytical queries against that
file. `agent-history/sql` supplies SQL and parameters; the Node analysis host
requests their execution through that path instead of opening the file while a
Python writer owns it. Python executes the query but does not duplicate its
definitions or shared calculations. The database work can run in a dedicated
application-owned executor outside the asyncio management loop.

This is a conservative extension of 061: that study queued its short-lived Node
readers behind the Python sync process and closed their handles between operations.
It did not establish unrestricted cross-process local-file access. Retain that
explicit handle handoff if it is cheaper for the first slice; do not leave a
long-lived Node connection open and merely serialize its requests at another
layer. Show queued/stale analytical views during an import rather than blocking
live control. MotherDuck gets its separately qualified target/connection adapter;
its concurrency behavior is not inferred from the local-file arrangement.

Browser Mosaic
tables serve compact UI working sets and remain separate from the analytical
history database. MotherDuck placement can change without changing live-session
control or native history semantics.

## Failure policy and acceptance

The recommended initial coordinator owns foreground resources and cleans them up
on normal exit. A browser detach is a different operation: Claude continues;
Codex follows its qualified subscription/lifetime policy; HP follows its actual
execution host. Stronger owner-survival modes are later deployment choices.

After a crash, read records and verify process identity before describing survivors
or stopping anything. A PID without its recorded identity is not ownership; a live
process without its relay is not a usable endpoint. Previous-owner observations
remain distinct from currently controlled resources. If supported reattachment is
unavailable, offer explicit native-history/HP-archive continuation, retaining lost
work and uncertain side effects. Do not replay old actions or reconstruct opaque
Claude internals. [065][s065] and the [recovery sketch](../failure-recovery.md)
support accepting that pragmatic loss.

| Acceptance obligation | Evidence / owner |
| --- | --- |
| A lost launch acknowledgement does not cause an unnoticed duplicate run; current versus prior owner is explicit. | Coordinator operation/run records; RC-07/08. |
| Stop one owned run leaves another intact; normal owner cleanup targets recorded identities; imported apps are inert. | Existing launcher integration checks plus 065; coordinator composition tests. |
| Zero Claude clients leaves the worker alive; concurrent clients receive one ordered replay/live stream; final output precedes exit. | 068 transport/native checks; RC-13. |
| Old callback replay does not execute again; pending native questions recover through the client; SDK close detaches only its connection. | 071 browser/Node and callback checks; `claude-client`, not Python arbitration. |
| Native history read starts no model work; continuation/fork retains the right boundary and unsent draft. | 058/064; RC-03/05/09/12; provider history adapters. |
| HP offline reads instantiate no connector; restored context works after a host change; stored jobs are not resurrected. | 070; RC-14; HP TypeScript host/history modules. |
| Broken/stalled processor or analytic target cannot block healthy forwarding; stale facts and capture gaps remain visible. | Existing observation tests, 034/068; coordinator analysis adapter. |
| Schema/price calculations preserve source/response identities, missing coverage, inherited work and out-of-turn compaction. | 061/070; existing Python writer and shared TS modules. |
| Native unknown config survives editing; launch overrides do not change saved defaults; login cancellation has an explicit result. | Existing profile/auth tests and 060/063; provider libraries. |

These are delivery checks, not a claim that the new coordinator already passes
them. Run real local subprocess/network tests first and small bounded Luna/Haiku
checks where provider compatibility is the question. Qualify Linux deployment
and any Hostfork composition before claiming their failure guarantees; the recent
browser/continuation evidence was primarily local macOS research.

## Decisions that need an answer at the right time

| Needed before | Decision for review |
| --- | --- |
| Codex launch configuration | No retained host subscription. Expose a longer native server-start unload interval; a specific new default and per-thread support have not been established. |
| HP persistence implementation | Apply D5's delegated initial checkpoint/save policy; qualify commit errors and fresh-owner restore. Stronger durability/recovery remains later work. |
| Shared Claude callbacks beyond basic native permissions | Avoid a main-observer selector. Discuss a concrete callback only if designated ownership proves necessary; no speculative election or server arbiter. |
| Making normal coordinator exit preserve execution | Select and qualify independent endpoint/pipe hosting for each provider. Until then normal owner shutdown is explicit cleanup. |
| Automated recovery | Which failures permit automatic reconciliation/relaunch? Credential changes meanwhile stay session-independent and expose native failures without coordinating other work. |
| Multi-host routing and cloud publication | Which configured peers/targets are initially included, and whether clients can reach their direct endpoints? Start from selected hosts; no global takeover or consensus mechanism is required. |

The first backend slice needs no new general policy engine: compose current
provider/profile libraries, expose inventory and explicit launch/stop with a typed
connection description, and preserve ownership facts. Claude's process/attachment
change, HP host extraction and the analysis host can then proceed as separate
lanes against those contracts. They should converge in complete application
journeys rather than becoming a collection of indefinitely unintegrated services.

[s060]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/060-authentication-flows.md
[s061]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/061-ingestion-statistics.md
[s063]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/063-profile-workbench.md
[s064]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/064-history-continuation.md
[s065]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md
[s066]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/066-claude-setup-token.md
[s068]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md
[s069]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/069-provider-history-matrix.md
[s070]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/070-hp-backend-parity.md
[s071]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/071-claude-sdk-replay.md
[s057]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/057-launcher-inactive-turns.md
