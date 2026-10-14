# Joint implementation sequence

**Status:** implementation roadmap; a first subset is now implemented and tested.
See [current status](../implementation-status.md), not this roadmap, for completion
claims. Read the
[architecture overview](../architecture.md) and the Codex/MITM architectures first.
The [launcher plan](codex-launcher.md) and [MITM plan](mitm.md) define detailed tasks;
this page defines their dependency order and shared completion gates.
The later Claude and Hostfork tracks have their own [Claude plan](claude-launcher.md)
and [Hostfork plan](hostfork.md). See the [Claude checkpoint](../claude-handoff.md)
for its current stopping point and next steps.

The follow-on [Codex client plan](codex-client.md) and
[API design](../specs/codex-client.md) are proposed after spikes 025–034. They have
an explicit review gate before construction and do not change the implemented
Python launcher or MITM boundaries in this roadmap.

The [trusted-operation stance](../design-principles.md) is already agreed. Implement
sandbox/approvals off, all-interface TCP binds and long-lived client connections
without mandatory grants, Origin gates or arbitrary expiry. Keep native config
native; prioritize copy/path/ownership hygiene over a security-policy framework.
Do not make lockdown or comprehensive redaction a first-release dependency.
Foreground/application ownership, PID-aware cleanup, thin inspection-only relays,
no initial capture caps, no-sidecar defaults and composable Typer CLIs are agreed.

## Delivery strategy

Build a small usable local system with explicit processor hooks and file/test
implementations, not a plugin process farm. An optional async FastAPI adapter or
small remote exporter can follow those hooks without blocking the local slice;
daemon mode and remote profile migration are not required. Keep the packages
independently testable and release
them using the repository's existing human-operated, lockstep release process.
Do not change that process merely because implementation is staged.

After the design/compatibility gate, the two package tracks can proceed in
parallel with separate source and test ownership. Coordinate changes to root
development dependencies, `uv.lock`, shared documentation navigation, and CI through
one owner. Add dependencies only when the step that needs them is implemented.

## Sequence and integration gates

### 0. Accept the design and establish compatibility

- Approve the remaining launcher-owned metadata, API boundaries, supported platforms, and
  first-release scope. Record deviations as small changes to the owning proposal.
- Run the compatibility investigations in each package plan before promising the
  selected Codex/engine behavior: transport support, predictable state selection,
  credential-helper renewal, proxy trust, and capture hooks.
- Record executable/engine versions, source revisions where available, platform,
  sanitized effective configuration, and exact reproduction commands.
- Separate verified capabilities from unsupported or untested combinations; fail
  clearly for unsupported requested modes rather than silently changing behavior.

**Exit:** the first vertical slice has a tested dependency/platform baseline and
no unresolved prerequisite disguised as an implementation assumption. Features
outside that slice may remain gated; they do not block unrelated local work.

### 1. Implement each independent local foundation

**Launcher track:** profile resolution and persistence, selective import, executable
identity, environment construction, ownership locking, and a minimal managed
app-server lifecycle with PID-aware status/stop and no attach/daemon mode.
Export a Typer app/factory, reusable beneath another application's CLI.
Temporary profiles belong to this core track, not a distant
convenience feature. Implement the authentication paths and their validation gates
in the launcher plan; do not equate a profile schema with working authentication.

**MITM track:** engine child startup/readiness/shutdown, process-scoped proxy/trust
configuration, forwarding-only operation, full local recording, simple processor
hooks, reusable Typer CLI and live capture controls. Monitor rather than impose
initial capture quotas. Validate HTTP, TLS, streaming, and both WebSocket message
directions using real local clients and services before introducing Codex interpretation.

**Exit:** the launcher can run without MITM, and the sidecar can serve an unrelated
consumer without Codex. Each has meaningful tests for cancellation, startup failure,
unexpected child exit, and cleanup, not only a happy-path demonstration.

### 2. Integrate the smallest useful end-to-end path

Compose the MITM public lifecycle/configuration boundary from the launcher. Do not
create a third package solely for this integration. Agree on the actual boundary
with the owning package before adding an optional dependency or extra.

The integration acceptance run must demonstrate:

1. An isolated profile and ready sidecar; app-server receives only the intended
   proxy, trust, authentication, and environment settings.
2. A small live model turn using the requested inexpensive entitled model, with
   actual outbound transport identified from evidence rather than inferred from
   its model name or inbound listener.
3. Recording toggled on and off while an existing WebSocket remains connected,
   separately tested with a controlled local service if the live model connection
   is too short. A completed turn alone is not proof of mid-connection control.
4. Useful capture records with payloads, unknown fields, ordering/correlation and
   explicit completeness/loss information, including HTTP fallback if supported.
   Optional masking is labeled, not required to record or route data.
5. Consumer exit and cancellation shutting down the sidecar and finalizing capture;
   sidecar failure producing the documented consumer policy rather than a silent
   direct connection or unnoticed loss of required evidence.
6. No change to the developer's normal configuration, credentials, system proxy,
   or CA trust. Explicit credential snapshots may still create the upstream
   refresh-token race described in the launcher proposal; local nonmutation does
   not prove that a shared refresh credential is safe.
7. Launch without MITM is still the default and needs no proxy dependency or CA.
   Explicit sidecar launch supports both recording-off and recording-on; off-mode
   establishes interception but keeps no payload archive. A direct/excluded
   connection is not advertised as capturable retroactively.

**Exit:** the local launcher-plus-sidecar path is reproducible. Failure cases and
unsupported modes are as visible as the successful demonstration.

### 3. Complete the client-facing relay and observability

Follow the launcher plan for native/adapter transport choices, trusted all-interface
listening, actual failure/shutdown behavior and protocol recording. Prove ordinary
browser access with no launcher grant ceremony and no arbitrary connection expiry.
Honor real native backend requirements without turning them into a second client
authorization system. Keep relay recordings distinct from upstream MITM captures.

Exercise small file/test processors alongside generic recording, using explicit
selection first and optional provider discovery/CLI contributions for convenience.
Copy/enqueue messages, then inspect them in independent async tasks; neither
parsing nor an export acknowledgment can gate forwarding. A sink failure, slow
observer, malformed record or interpreter exception is reported without stopping
healthy traffic. Do not require per-plugin worker processes.
Verify that configured sinks receive full records, including dummy credential and
unknown payloads, and that optional masking changes only recording. Do not require
per-field consent or another approval to send data to a configured trusted sink.
Codex-aware metric extraction lives in the launcher or an adjacent integration,
not MITM. Track source attribution and cumulative-versus-delta usage to avoid
double-counting; missing usage/cost stays unknown. Logfire/Grafana-compatible
exporters are optional small adapters, not infrastructure prerequisites.

**Exit:** browser and native clients can exercise the supported raw protocol without
losing server-initiated requests. Full observed payloads survive large-message
tests without the earlier size/truncation/run quotas. Backlog, storage, latency
and observer errors are visible; forwarding never waits for capture/export.
Actual engine buffering and finite-machine limits remain documented, not called
unlimited-resource guarantees. Remote output remains optional and independently gated.

An optional FastAPI adapter can expose status/stop/capture operations at this
stage if useful, using the existing async owner and no second supervisor. The
Typer apps must also work standalone and mounted beneath another application's
command tree. Neither adaptation changes lifecycle or interception semantics.

### 4. Qualify reliability and prepare a human-operated release

- Complete the platform and failure matrix in both package plans. Include
  overlapping profile launches, parent/child crashes, stale ownership, full disks,
  oversized streams/messages, and existing-connection recording changes.
- Test both distributions independently and in combination from built wheels;
  optional integrations must not break the minimal installations.
- Run repository checks, strict documentation and package builds, and the relevant
  Python-version/platform matrix. Keep paid live tests out of ordinary untrusted PR
  execution; use explicitly provisioned credentials and isolated state.
- Replace proposed usage examples with verified examples only when they actually
  work. Publish a tested compatibility matrix and known limitations.
- Leave versioning, release dispatch, tags, and publishing to the maintainer under
  the [development guide](../development.md#releases).

**Exit:** the maintainer has evidence and a release checklist, not an automatic
publication triggered by an agent or an ordinary code push.

## Testing and evidence policy

Deterministic unit tests and real local protocol servers are appropriate for
parsing, lifecycle, streaming, failure injection, and optional masking tests.
They do not prove provider behavior. Use small live calls when verifying Codex
authentication, upstream transports, model behavior, or token renewal; do not
substitute canned inference responses for those acceptance checks.

Use the requested low-cost model when available, record the exact resolved model,
and do not silently substitute a more expensive one. Keep each probe bounded in
turns, output, time, and retries. Stop to inspect unexpectedly growing usage; aim
for USD 0.05–0.10 per investigation, with up to USD 1 authorized for important
validation; coordinate aggregate spend across agents. Where usage/pricing is insufficient to
enforce a monetary cap, report that uncertainty and rely on the hard execution
bounds rather than claiming exact spend control. Subscription API-equivalent
estimates are not invoices.

Keep raw captures and credential-bearing output private under ignored local
artifact paths, not in CI uploads by default. Published evidence includes versions,
commands, sanitized summaries, limitations, and whether it came from source
inspection, a local service, or a live upstream run. Existing spike results are
background evidence; package compatibility requires checks against the package
implementation itself.

## Deferred work

Lockdown mode, detached daemon/attach workflows, distributed ownership, live
home-directory replication, cloud backup/restore and a general thread SDK are
outside the initial Python delivery. A separate [Codex client plan](codex-client.md)
now proposes the browser/Node SDK follow-on, awaiting review. Strong plugin-process isolation and capture quotas
are later guardrail discussions, not hidden requirements. FastAPI management and
small remote exporters are optional follow-ons using the early hooks.
State portability needs its own snapshot-consistency
and explicit contents/restore design, not an assumed secret-filtering framework.
Adding it later must not quietly expand the meaning of a
profile import or turn machine-local locking into a distributed-lock promise.
