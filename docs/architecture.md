# Architecture proposals

**Status:** architecture baseline with a first local implementation. Read
[implementation status](implementation-status.md) for the supported subset and
evidence; this proposal still contains future interfaces and qualification gates.

The maintainer has agreed the [trusted-operation principles](design-principles.md):
one advanced operator and trusted agents/clients inside an operator-controlled
network. Default sandbox off, approval prompts off, and TCP listeners on all
interfaces. Prioritize state/process hygiene, simple native-config copying and
useful captures. No mandatory client grants, timed disconnects or comprehensive
secret-classification/redaction machinery. Lockdown is a separate later mode.
The subsequent review also settled foreground/application ownership, PID-aware
cleanup, a thin asynchronous inspection tap, no initial capture quotas, no-sidecar
defaults and reusable Typer CLIs. Processor hooks start small; detailed contracts
and compatibility still require implementation evidence.

## Start here

The workspace has four independently useful parts:

- **`pdum.codex_launcher`** owns a Codex profile and its managed process: selecting
  configuration, preparing authentication, starting and stopping app-server, and
  optionally exposing a client-facing relay.
- **`pdum.mitm`** owns a generic network interception sidecar: routing selected
  traffic, capturing application-level exchanges, and changing recording policy
  while forwarding continues. It has no knowledge of Codex accounts or models.

- **`pdum.hostfork`** owns host-derived Linux views, private trees, process groups,
  independent deadlines and recoverable evidence. Applications compose it through
  its async library or CLI; it has no dependency on either package above.

- **`pdum.claude_launcher`** owns Claude profiles and foreground native workers,
  while official browser/Node SDKs own live conversations. Its separate management
  API uses official Python SDK history helpers. Several workers share a profile;
  each connected controller owns one worker. See the [Claude specification](specs/claude-launcher.md)
  and [qualification report](claude-validation.md). It has no dependency on Codex.

The launcher composes the sidecar when requested. The MITM package never imports
the launcher. Sharing a repository does not require sharing a process supervisor,
configuration schema, logging format, or public API.

```text
CLI / Python application
         |
         v
launcher: profile ownership, authentication setup, process lifecycle
         |
         +---- optional client relay <---- application / browser
         |              |
         v              v
                  Codex app-server
                         |
                         +---- direct upstream connection
                         |
                         +---- optional MITM sidecar ---- upstream services
```

The relay observes **client ↔ app-server protocol messages** by copying them to
an independent async inspection/export path. The MITM sidecar observes **proxied
network traffic**, including app-server ↔ model-service traffic.
An inbound WebSocket does not imply an outbound WebSocket, and neither recording
surface can substitute for the other.

No MITM sidecar is the normal launch default. When selected, the sidecar sets up
interception before Codex connects; recording can be off or toggled later. Turning
recording on does not retrofit interception onto a direct/tunneled connection.

## Reading order

| Document | What to review |
| --- | --- |
| [Agreed design principles](design-principles.md) | The settled trust/default/hygiene stance; do not reintroduce defensive defaults without discussing a requirements change. |
| [Launcher architecture](specs/codex-launcher.md) | Profile layout and selection, temporary profiles, upstream authentication, async ownership, transports, and relay behavior. |
| [MITM architecture](specs/mitm.md) | Engine and process boundaries, proxy/trust configuration, capture fidelity/monitoring, processor hooks, and live controls. |
| [Hostfork motivation](specs/hostfork/motivation.md) and [compatibility](specs/hostfork/host-compatibility.md) | Host-derived environments, storage choices and failure modes. Linux implementation: [guide](hostfork.md); future backends remain proposed. |
| [Hostfork architecture](specs/hostfork/architecture.md) and [implementation plan](plans/hostfork.md) | Proposed library, host tools, Linux ownership/recovery and future backend boundaries, informed by spikes 020–024. |
| [Joint implementation sequence](plans/implementation.md) | Dependencies between packages, shared acceptance gates, and what to implement first. |
| [Launcher implementation plan](plans/codex-launcher.md) | Launcher work packages and their completion criteria. |
| [MITM implementation plan](plans/mitm.md) | Sidecar work packages and their completion criteria. |

The package architectures own their respective contracts. This page and the joint
plan summarize composition, not a third competing API specification.

## Requirements retained from the discussion

The launcher rows below describe Codex. Claude uses its own
[specification](specs/claude-launcher.md), especially multiple workers per profile,
client-owned SDK queries and disconnect-ending worker lifetimes.

| Requirement | Design owner |
| --- | --- |
| `pdum-codex` CLI and a Python library; explicit profile directory or CLI name/root selection | Launcher |
| Create, interview, list, and selectively import profiles; persist executable selection | Launcher |
| One managed process per profile per machine, including crash recovery | Launcher |
| Foreground/application-owned lifetime; PID/process identity and easy verified cleanup; no daemon or attach convenience | Launcher |
| `asyncio` subprocess control, bounded readiness and shutdown | Each package for its own child |
| Dedicated ChatGPT login, API keys, and **API-platform** federation | Launcher |
| No special interception or orchestration of client-initiated account login | Launcher relay |
| Clean or cloned temporary profiles with convenient warning-based credential reuse | Launcher |
| Native config stays native, including unknown fields and credential/helper references | Launcher |
| Sandbox/approvals off and all-interface TCP defaults; no arbitrary connection expiry | Launcher; MITM uses the same network stance |
| Controlled child environment, configurable listener, explicit transport adapters | Launcher |
| Browser-facing relay with unchanged messages and separate async recording/metric/export processors | Launcher |
| Generic optional upstream MITM, including WebSocket and streamed HTTP capture | MITM |
| Enable/disable recording and change destinations without restarting the consumer | MITM; launcher exposes the integration |
| Full observed payloads without initial capture-size caps; monitor backlog/storage and report failures without stopping healthy traffic | Both observation surfaces |
| Explicit processor hooks, small local/test sinks, optional discovery and CLI contributions | Each package's observation boundary; Codex interpretation in launcher or adjacent integration |
| Exported mountable Typer apps/factories | All packages |
| Optional small async FastAPI management adapter | Launcher follow-on using the existing owner |
| Remote profile migration and daemon mode | Deferred, not initial delivery |

## Cross-package invariants

1. **One owner for each lifecycle.** The launcher owns app-server; the sidecar
   manager owns its proxy child. Integration uses the MITM public boundary rather
   than reaching into its subprocess or engine internals.
2. **Readiness precedes use.** The sidecar must be ready before its proxy settings
   are supplied to app-server. Stop the consumer before the sidecar's final drain.
   Cancellation and failures follow the same bounded cleanup path as normal exit.
3. **Optional really means optional.** A launch without MITM must not require a
   proxy engine or an interception CA. MITM must be useful without Codex installed.
4. **Isolation is explicit, not a security claim.** Dedicated homes and controlled
   environments prevent accidental reuse of developer settings; they are not an
   OS sandbox or a way to override host policy. No global proxy or trust changes.
5. **Useful data inside the trust boundary.** Copy requested native configuration
   without a secret-classification layer. Credential reuse produces a concise
   warning, not a consent workflow. Enabled captures may contain tokens and unknown
   payloads; simple masking is optional. Routine status need not dump them.
6. **Publication is different from capture.** Operator-configured local or remote
   sinks may receive full data without another export gate. Do not send it to an
   unconfigured sink or commit it to Git/public CI. Recording off is volume control,
   not a trust policy; missing/truncated/dropped records remain explicit.
   No initial payload/decoder/queue-admission caps or run quotas truncate captures;
   monitor bytes, lag, storage and failures. Actual engine omissions, disabled
   intervals and failed writes are still limitations, not erased by this policy.
7. **Version-dependent behavior is checked.** Native transports, authentication
   helpers, proxy use, and protocol support need evidence from the selected binary
   and engine. A design choice or old spike result is not a new compatibility test.
8. **Raw protocol stays raw.** The relay is not a thread SDK and does not silently
   rewrite account, model, approval, or sandbox messages. Observability must not
   become another owner of agent execution or authentication renewal.
9. **Inspection does not gate forwarding.** Copy/enqueue observations without
   awaiting processors. Parsing, disk and exports run separately; failures are
   visible but do not intentionally stop healthy traffic. Cooperative async
   isolation is not a promise of unlimited memory or hard plugin fault containment.
10. **Composition stays lightweight.** Export Typer apps/factories and explicit
    processor selection. Use local/test processors to prove the hooks before
    optional exporters; no initial per-plugin process framework. FastAPI, if added,
    delegates to the same owner instead of creating a second lifecycle.

## What needs review before implementation

The architectures make recommended choices rather than leaving every decision
open. The trust stance and thin-profile/native-config direction are now agreed.
Foreground ownership, duplicate-launch failure with PID-aware cleanup, a thin
inspection tap, no initial capture caps, optional sidecar and Typer composition
are also agreed. Continue reviewing concrete profile/API shapes, native transport
compatibility, capture fidelity, auth integration and the first implementation
slice without relitigating those decisions. Source-dependent capabilities are
validation gates, not promises. Exact processor registration syntax and optional
FastAPI/exporter timing can remain small follow-on choices.

Implementation was subsequently authorized. Release actions remain human-operated;
the architecture alone is not evidence that a feature works.

## Review and research background

Two package authors and an independent reviewer produced the earlier draft. That
review improved consistency within its then-defensive assumptions. The maintainer
has since rejected those assumptions: mandatory credential filtering and relay
grant delivery have been removed, not left as implementation prerequisites.
Extension failure handling remains a reliability concern. The follow-up review
replaced initial capture quotas/per-plugin workers with monitored full captures
and simple async hooks, and selected composable Typer CLIs. The present revision
records those decisions; it is not new runtime/security validation or a
claim that the independent reviewer reviewed these subsequent changes.

Earlier investigations are now preserved in the repository's self-contained
`experiments/` workspace. See [research and spikes](research.md) for their index,
provenance, and exclusions. Importing those sources does not implement either
package or rerun the historical live experiments.
