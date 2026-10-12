# MITM sidecar — implementation plan

**Status:** proposed work breakdown; no stage is implemented. Apply the agreed
[design principles](../design-principles.md), including asynchronous inspection,
no initial capture caps and reusable Typer CLI hooks. Do not restore the earlier
redaction-first, quota-based or per-plugin-worker design. Read the
[architecture proposal](../specs/mitm.md) for the API and behavior contract.
The [joint plan](implementation.md) coordinates launcher dependencies.
Use the shared uv environment/lockfile and this package's tests directory.
No release, credential change or system proxy/trust change is part of this plan.

## Completion criteria

A first local candidate works without Codex, Logfire or a web server: an async
Python application starts a ready proxy, applies scoped routing/trust, captures
real HTTP/SSE/WSS, changes recording on existing connections and stops without
leaking child processes. Its archive either meets its stated completeness scope
or identifies actual omissions. Monitor backlog, storage and engine/observer
memory without claiming a whole-process resource bound.

Launcher integration adds a bounded real Codex probe proving the chosen client
uses the proxy. That is distinct from generic network tests. Remote sinks do not
block local usability. TCP defaults to all interfaces. Once recording is enabled,
raw payloads are useful evidence, not forbidden data. Simple masking is optional;
no secret classification or redacted-only plugin/export gate. No preset payload,
queue-admission or run-volume limits. Small file/test processors validate the
extension hooks early; remote exporters and lockdown can come later.

## M0 — engine qualification and compatibility envelope

**Dependencies:** architecture approval; no launcher implementation.

Create a narrow engine qualification harness before declaring the sidecar stable.
Deliberately add mitmproxy 12.2.3 to the package and root lockfile after verifying
installability on Python 3.12, 3.13 and 3.14 on supported macOS/Linux targets.
Record actual versions. If the pin cannot work on a target, report failure and
review a replacement; do not silently loosen constraints.

Use real local servers/clients and temporary CA material, not only mocked hooks:

- Port 0 reports the all-interface listener and a usable connect address; occupied
  ports fail without orphans. Explicit bind overrides work.
- HTTP/1.1 and TLS interception work. Missing client CA fails; scoped CA trust
  succeeds. Untrusted upstream certificates are still rejected.
- Negotiated HTTP/2 and HTTP/1.1-upgraded WSS work through the regular proxy.
- Request/response chunks arrive before end-of-stream and match peer bytes.
- Text/binary, fragmented/compressed WS messages appear in both directions;
  PING/PONG remain live without being falsely labeled archived messages.
- Clearing engine WS history does not drop/mutate the forwarded message. Check
  retained history on a long-lived connection.
- Startup/status report endpoints and state without dumping credentials. Deliberate
  detailed capture is a separate output, not forbidden data.

Measure memory for many small messages and a bounded large/fragmented message,
using a process-level test resource limit. Do not run an unbounded decompression
bomb on the developer machine. Document pre-hook reassembly, latency effects and
engine API touchpoints. Trimming completed messages is not proof of safe handling
of adversarial fragments.

**Exit gate:** redacted compatibility report, exact versions and measured results;
real-network tests pass. Remove unsupported protocols from advertised capability
or block the gate. This report is new evidence, not a copy of the older spike.

## M1 — lifecycle, scoped configuration and control

**Dependencies:** M0 listener/startup/trust findings.

Implement typed config/errors, private engine/worker adapters, control framing,
`open_sidecar`, `SidecarHandle` and selected environment/trust adapters. Add a
Typer CLI with exported app/factory, using the same library operations.
Forwarding-only mode must work before any recorder. Errors distinguish validation,
startup, timeout, protocol mismatch, unexpected exit and cleanup failure.

Create a private run/CA directory without importing ordinary user configuration.
Implement structured readiness, concurrent pipe draining, heartbeat supervision,
EOF shutdown and bounded cancellation cleanup. Expose the connection contract
to the launcher; never take hidden ownership of its consumer.

Acceptance tests:

1. Concurrent port-0 starts do not race. Fixed-port conflicts fail predictably.
   No readiness sleeps or parsing human console text.
2. Cancellation at every startup phase reaps workers/removes temporary state.
   Double close is safe; uncooperative workers are killed and reaped.
3. Parent death closes control and worker exits. Oversized/malformed commands,
   version mismatch and stdout/stderr floods cannot hang the parent.
4. Environment helpers return copies, normalize variants, honor explicit bypass,
   reject contradictory overrides and preserve baseline trust roots. Parent
   environment, user proxy settings and system trust remain unchanged.
5. A non-Codex sample consumer uses the sidecar; proxy death reports a fatal
   signal. Its host performs consumer shutdown, not the generic sidecar.
6. Off-mode creates no payload archive. Ordinary health diagnostics remain useful.
   Unique paths, private-file defaults and collision checks prevent wrong-output
   writes; no hostile-local-user permissions framework.
7. Mount the Typer app under a separate test application's subcommand and exercise
   help/validation/foreground launch through the same library. Import/mount has no
   process or signal side effects; two factories have independent command trees.

**Exit gate:** lifecycle/API usable by launcher development; typed contract and
failure semantics documented. Do not claim recording functionality yet.

## M2 — local capture, processor hooks and live configuration

**Dependencies:** M1; parallel with launcher profile/auth development.

Implement observation envelopes, streaming adapters, independent observation
queues/tasks, local writer/rotation/manifest, health/loss counters and barriers.
Introduce interpreter/sink hooks and small file/test processors at this stage,
with explicit importable factory selection suitable for the worker process.
Preserve complete observed payloads by
default once recording is enabled, including unknown text/binary/JSON fields.
Derived decoding and optional masking are conveniences, not data-export permissions
or prerequisites. IDs/sequences remain application-independent.

Do not implement preset queue/payload/metadata caps, decoder expansion cutoffs,
run quotas, a plugin process farm or a strict-capture stop mode. Monitor pending
bytes, oldest observation age, processor latency/failures, storage and memory.
Use finite test workloads to expose contention and actual failure behavior; test
resource budgets are not runtime capture policy.

Inspect what both network peers receive as well as the recording. A good-looking
archive does not prove an unchanged or timely forwarded stream.

| Area | Required acceptance evidence |
| --- | --- |
| HTTP/payloads | GET/POST, duplicate headers, original URLs, empty/large bodies, errors, half-close, unknown encodings, invalid JSON and complete binary payloads. |
| Streaming | Identity/gzip/deflate SSE and JSONL split at awkward chunk/UTF-8 boundaries; early event delivery and complete decoded/encoded evidence without arbitrary cutoffs. |
| WebSockets | Bidirectional unknown JSON events, binary mode, fragmentation, negotiated compression, reconnect identity and clean/unclean close. |
| Runtime state | Open streams/WS while off, enable, switch destination/filter, disable and continue without reconnecting. |
| Boundaries | Revision/barrier sequences, missing prefixes, WS completion after enable, mid-compression enable, partial decoder state on disable. |
| Persistence | Rotation, partial final line, crashes, initial manifest, atomic finalization, flush watermarks and offline recovery. |
| Load/failures | Finite bursts, many flows, slow/failing writer, full disk and failed switch; forwarding does not wait for observers, backlog/errors are visible and healthy processors continue. |
| No hidden caps | Payloads above the old 1 MiB threshold and a finite run above the old 256 MiB quota retain complete evidence; rotation never truncates a record. |
| Processor hooks | Explicit factory/config selection, independent async dispatch, file/test sinks, derived attribution and cooperative exception/cancellation handling without per-plugin processes. |
| Capture fidelity/publication | Dummy credential-bearing and unknown payloads survive enabled capture. Optional masking is labeled and never changes forwarding. No actual private captures in public CI artifacts. |

Use real local TLS/HTTP/WS endpoints. Deterministic fixtures are appropriate for
malformed input, exact decoder regressions and disk/control failure injection,
not replacements for actual proxy execution. Assert omissions and failures as
well as success. Do not bake model-provider event names into the generic schema.

Implement an offline archive validator and explicit closed-run inventory/prune
utility. Distinguish unknown schema, missing segments, unfinished manifest,
sequence gaps and intentional off intervals; never silently call incomplete
evidence complete. Prune is dry-run by default and refuses live/unrelated paths.

**Exit gate:** useful local candidate including processor hooks, documented
limitations and persistent-WSS capture-toggle example. Measure latency/memory and
backlog with capture off/on and a deliberately slow output; set test regression
thresholds from measurements without turning them into runtime capture quotas.

## M3 — optional discovery, provider CLI integration and remote adapters

**Dependencies:** M2 records/barriers. Does not block local candidate or
basic launcher integration.

Add entry-point metadata listing/selection and selected providers' Typer
registration hooks over the M2 contracts. Test namespaced options/subcommands,
help, collisions and mounting beneath another app. Explicit factory selection
continues to work without discovery; installed providers are not auto-activated.
Do not rebuild extension execution as per-plugin subprocesses.

Use small processors that await slowly, raise or return invalid derived data
alongside a healthy processor. Cooperative failures do not block healthy output or
forwarding; backlog, incomplete delivery and errors are visible. Document that a
malicious/noncooperative CPU loop or process crash is not isolated by async tasks.
No initial queue/extension-count limits or credential/export authorization layer.

A remote adapter, if useful now, uses the same hook as the test/file sinks and
optional dependencies. Use a real local HTTP sink for batching/failure tests and
one small live Logfire export only when that adapter is added/configured. Do not
promise a particular code-line count or a general observability backend. Document
accepted versus durable delivery, timeout uncertainty, switching and lack of
automatic retries. Harmless test data can prove full-payload delivery without
publishing private captures.

**Exit gate:** discovery/CLI composition works without Codex, or is explicitly
deferred while direct selection remains useful. Selected remote adapters do not
change local-only imports, forwarding or capture policy.

## M4 — launcher integration and real-model confirmation

**Dependencies:** M2 plus launcher isolated startup/auth/teardown. M3 only if
testing discovery or a remote adapter; simple Codex processors use M2 hooks.

Launcher owns the consumer adapter; Codex interpretation lives in the launcher or
an adjacent integration, not this package. Jointly test startup
ordering, scoped proxy/trust, fatal-sidecar shutdown, child-first cleanup,
capture-only degradation and persistent/temporary profile cleanup. Cover no-sidecar
launch as the normal default, sidecar with recording off, and sidecar with recording
on. Off-mode must retain the intercept path without a payload archive; toggling
recording does not retroactively intercept a direct/tunneled connection. Use the actual
selected Codex binary; environment variables alone are not evidence of routing.

Run one opt-in short live model turn through the proxy with the current available
`gpt-6-luna` requested by the user and the selected profile authentication flow.
Resolve/record actual model identifier; do not silently substitute a costlier one.
Start recording off, enable before the turn, and verify actual model traffic.
Persistent local tests prove mid-stream toggles deterministically; do not claim
provider socket reuse without observing it.

Record executable/version/digest, Python/OS/engine versions, inbound/outbound
transports, observed model, connection/message counts, input/cached/output usage
and loss/truncation counters. Determine WSS or HTTP fallback from captured
traffic, not model naming. Use current official pricing for a dated estimate
separate from billing; do not copy old spike prices as current facts. Keep spend
near cents and reassess before exceeding the user's roughly $0.50 scale.
Synthetic API success is not proof of real upstream behavior.

**Exit gate:** redacted reproduction summary and private local evidence, with no
ordinary developer configuration/auth/session changes and no captured secrets
in Git. Report unavailable live auth or unsupported behavior honestly.

## Checks and handoff

Run targeted tests first, then checks in the [development guide](../development.md).
CI covers Python 3.12–3.14; add macOS lifecycle/TLS coverage when process features
land instead of assuming Linux proves macOS behavior. Ordinary CI includes real
local-network tests without paid provider calls. Credentialed live model/export
probes stay opt-in and outside pull-request CI.

Before release candidacy, build distributions and strict MkDocs, validate root
lockfile, run Ruff and test permissions from installed packages. Update README
examples/capabilities only after passing gates. Release is human-operated.
This plan does not authorize implementation before approval or publication.
