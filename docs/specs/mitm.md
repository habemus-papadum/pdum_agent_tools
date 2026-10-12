# MITM sidecar — architecture proposal

**Package:** `habemus-papadum-mitm` (`pdum.mitm`)
**Status:** design proposal, not implemented. The agreed
[design principles](../design-principles.md) include foreground ownership,
inspection-only hooks, no initial capture caps and composable Typer CLIs. These
supersede earlier defensive defaults and per-extension worker requirements;
detailed mechanics are still for review.
The [implementation plan](../plans/mitm.md) defines delivery gates.

## Executive decisions

Build generic, Python-controlled interception around **mitmproxy**, not a new
HTTP/TLS implementation. The first hosts are macOS and Linux, on Python 3.12–3.14.
One async context manager owns a proxy subprocess; the application owns the
process whose traffic it observes.

| Question | Proposal |
| --- | --- |
| Engine | Qualify and initially pin mitmproxy 12.2.3, used in the earlier live spikes. Hide internals behind one adapter. |
| Defaults | Explicit HTTP proxy on all host interfaces, TLS interception, **recording off** for volume control. No global proxy/trust changes. |
| Capture | HTTP metadata and streaming bodies, JSON/JSONL/SSE interpretation, bidirectional WebSocket messages. |
| Control | Private inherited pipes, versioned commands/acknowledgments; no HTTP server required. |
| Storage | Versioned JSONL segments and manifest; useful full payload capture when enabled, optional simple masking. |
| Load | No initial capture-size caps or disk quotas. Monitor backlog/storage and prefer forwarding over recording; expose actual omissions/failures. |
| Extensions | Explicitly selected interpreters/sinks on a separate observation path; simple file/test processors first, no worker process per extension. |
| CLI | Exported Typer app/factory, mountable under another application; optional provider discovery and namespaced commands. |
| Integration | Launcher or adjacent integration supplies Codex-specific presets/interpretation. Core knows nothing about agents, models, profiles or login. |

No implementation, dependency changes or new live validation accompany this
proposal. Earlier evidence is identified at the end.

## 1. Scope and non-goals

The first complete delivery supports regular explicit proxying of HTTP/1.1,
HTTPS, negotiated HTTP/2, and HTTP/1.1-upgraded WS/WSS. Coverage is a tested
matrix, not a promise to observe every socket in a process tree. Proxy environment
variables are client hints, **not an egress firewall**.

Exclude transparent networking, pcap, TLS-key-log export, HTTP/3/QUIC interception,
SOCKS, replay/traffic mutation, browser UI and automatic cloud upload initially.
Unknown protocols may be forwarded by the engine but are outside capture guarantees.
Original frame boundaries and PING/PONG are not archived as WebSocket messages:
mitmproxy exposes reassembled text/binary messages and forwards control frames.
[Protocol limitations](https://docs.mitmproxy.org/stable/concepts/protocols/)
and [message representation](https://docs.mitmproxy.org/stable/api/mitmproxy/websocket.html)
define this boundary.

This is debugging infrastructure for one advanced operator and trusted clients
inside their network. The operator provides the external network boundary; this
package does not authenticate or sandbox those clients/plugins. Bind TCP to
`0.0.0.0` by default, with configurable addresses and tested IPv6 support. Show
actual endpoints; do not impose loopback-only operation, proxy auth or recurring
security prompts. Later lockdown is separate, not a first-release prerequisite.

## 2. Components and ownership

```text
Host application / Codex launcher
  SidecarHandle: asyncio subprocess supervision + private control pipes
    |
    +-- proxy worker: pinned engine + first-party observation addon
    |     client <---- HTTP(S)/WS(S) ----> upstream
    |                  |
    |                  +--> copy + nonblocking enqueue
    |                         observation dispatcher off engine event loop
    |                           +-- local writer -> manifest + JSONL segments
    |                           +-- selected interpreter / sink tasks
    |                               -> derived records / metrics / remote output
```

The local-only path needs one child. Launch using
`asyncio.create_subprocess_exec(sys.executable, "-m", "pdum.mitm._worker", ...)`,
not a shell or a `mitmdump` discovered on `PATH`. A pinned adapter owns
`DumpMaster` setup, listener inspection and shutdown in the child's event loop.
These embedded engine APIs carry compatibility risk, not an assumed stable
public interface. Engine upgrades must pass the qualification suite.

Disable terminal UI, dumper, replay, content mutation and automatic loading of
the user's `~/.mitmproxy/config.yaml`. Supply private `confdir`, options and
the first-party addon explicitly. Keep bounded operational diagnostics and avoid
gratuitous credential/environment dumps. Detailed engine diagnostics may contain
URLs or payloads; retain them only
when requested, without a universal secret detector or a promise of anonymization.

Only copying or retaining immutable payload data, counters and nonblocking queue
insertion run in traffic hooks. Never truncate the observation to meet a capture
budget. HTTP stream callbacks return the original bytes. Parsing, decompression,
optional masking, hashing, file writes and exports run behind the queue, not in
traffic callbacks. Initially use an observation dispatcher on a dedicated thread
with its own async task loop; each selected processor has a separate queue/task.
Offload blocking I/O from that dispatch loop as needed. Measure actual contention:
a shared process/GIL is not hard CPU or memory isolation.

A stalled writer/exporter must not deliberately backpressure forwarding. Report
backlog/lag and processor failures; do not stop the consumer because recording
failed. No size-based queue admission/drop policy or per-plugin process is needed
initially. Resource guardrails can follow measurements; shutdown still has a
deadline and reports unfinished output. Allocation/process failure remains a
limitation, not a promise of unlimited reliable capture.

Proposed modules: `config`, `sidecar`, `control`, `environment`, `records`,
`storage`, `decoding`, `extensions`, private `_worker`/`_engine`.
Use typed frozen dataclasses and explicit validation. No extra configuration
framework or web framework is needed solely for the sidecar.

## 3. Public library and launcher contract

These are proposed APIs, not runnable examples. This is the canonical MITM
integration boundary; consumers link here instead of duplicating worker internals.

| Surface | Contract |
| --- | --- |
| `open_sidecar(config: SidecarConfig, processors=...)` | Async context manager; enter returns after readiness. Owns proxy and its observation tasks, never the consumer. Optional processor specifications select importable factories and configuration. |
| `handle.connection` | Immutable `ProxyConnection(proxy_url, ca_cert_path, run_id)`, valid until close. URL uses a connectable address/actual port, not a wildcard bind address. |
| `connection.environment(base, trust=...)` | Returns a new environment mapping for an explicitly selected tested trust adapter; does not mutate parent environment or global trust. |
| `await handle.status()` | Lifecycle, engine/version, revision, sequence, capture state, bytes, queue backlog/age, processor latency/failures, losses and storage health. |
| `await handle.configure_capture(change, expected_revision=...)` | Atomic policy change; returns `CaptureAck(revision, boundary_seq, drained_through_seq, losses)`. |
| `await handle.flush()` | Observation barrier; returns `FlushResult(through_seq, persisted_through_seq, losses, complete)`, without stopping forwarding. |
| `await handle.wait_failure()` | Returns typed `SidecarFailure` on fatal forwarding/control/worker failure. Capture loss alone is not fatal. Normal close ends waiting as closed, not failed. |
| `await handle.aclose()` | Idempotent bounded shutdown; returns final capture status. Context exit invokes it. |

`SidecarConfig` separates immutable launch settings from mutable `CaptureConfig`.
Bind/port, private work directory, routing/trust, TLS exclusions and timeouts
are launch settings. Recording state, filters and selected sinks
are capture settings. Unknown fields, bad paths, unsupported engine versions and
incompatible trust adapters fail before the consumer starts.

Host order: open sidecar → obtain connection settings → start consumer →
supervise both → stop/reap consumer → flush/close sidecar. Unexpected proxy death
is fatal; the launcher stops Codex rather than silently retrying directly. A
capture-only error leaves forwarding alive and is reported to the host. Do not
add a strict-capture failure policy that terminates otherwise healthy consumers.

Do not add a second general process launcher here. An `async with` recipe with
`create_subprocess_exec` serves other consumers. The
[launcher](codex-launcher.md) owns its child environment and lifecycle.

### Reusable CLI

Use Typer for a proposed `pdum-mitm` command, exporting `pdum.mitm.cli.app` and
`create_app(...)` for mounting as another application's subcommand. A new factory
instance has independent provider registration; importing/mounting does not start
the engine or an event loop. CLI handlers bridge to the same async library, not
duplicate its lifecycle. Another async application calls the library directly.

Allow explicit processor specifications in the API and CLI/configuration without
requiring entry-point discovery. Installed provider discovery can support listing,
help and selected providers' namespaced options/subcommands. Register them while
constructing the app, before parsing, with clear duplicate-name/option errors.
Discovery alone neither activates capture nor starts a processor. Commands for
foreground launch, status and recording choices are the initial surface; command
spelling and provider option syntax remain implementation-level design choices.

## 4. Lifecycle, readiness and failure

States: `new → starting → ready → stopping → closed`; fatal errors add `failed`
before cleanup. Capture health is separate, so recording can degrade while the
proxy remains ready.

1. Validate configuration; create a fresh `0700` run directory and `0600` files.
   Reject existing run IDs and symlinked private output targets.
2. Start worker with inherited stdin/stdout control pipes and drained stderr.
   Initial configuration travels through the pipe, not secret-bearing arguments.
3. Engine binds the configured interface (default all interfaces) and **port 0 itself**,
   or the requested fixed port. Never
   reserve/release a free port before spawning. Wait for server setup, inspect
   the bound listener, and verify the run-local CA exists.
4. Receive structured `ready`: run/protocol/engine versions, endpoint and CA
   fingerprint. Return a local connect address such as `127.0.0.1` for an IPv4
   wildcard bind, or an explicitly advertised host for remote consumers. Parent TCP
   connect confirms listening. This does **not** prove
   upstream routing or client trust; an actual consumer probe must do that.

Pinned `Master.run()` sets up proxy servers before running hooks; the adapter
must still reject startup errors and an empty listener set.
[Startup source](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/mitmproxy/master.py)
is the evidence, not a claim the proposed adapter already passes tests.

Defaults: startup 15 seconds; control request 5 seconds; final drain 5 seconds;
graceful exit 5 seconds; SIGTERM grace 2 seconds, then SIGKILL/reap. Use monotonic
deadlines and concurrent pipe readers; undrained subprocess pipes can deadlock.
[Python subprocess docs](https://docs.python.org/3/library/asyncio-subprocess.html)
support the async primitive and this constraint.

Close stops new proxy connections, marks open flows incomplete, drains admitted
observations within deadline, closes sinks and shuts down the engine. Do not
await long-lived WebSockets indefinitely. Finalize the manifest only on clean
capture completion. Cancellation runs shielded bounded cleanup, then re-raises;
cleanup errors accompany rather than replace the original failure.

Parent-pipe EOF triggers worker shutdown. Heartbeat every 2 seconds detects
an unresponsive worker after 10 seconds; parent marks failure and terminates it.
Observation tasks shut down with their worker. SIGKILL/machine loss
can leave files and cannot promise a flush. No automatic restart reconnects
an existing consumer. Keep reading pipes during all shutdown phases.

## 5. Routing, certificates and environment

Generate a fresh CA in the private run directory. Give consumers its certificate
path only; keep the private key in the worker's `confdir`. Remove work/CA state
after consumers stop. Durable capture output has a separate destination.
Reusing a caller-supplied CA is deferred, not an implicit read of the user's CA.

Keep ordinary upstream TLS verification enabled (`ssl_insecure=false`) so the
client reaches the intended upstream. Allow configured private roots and deliberate
engine test overrides without a new security permission system. Consumer trust adapters
either append the run CA using a supported mechanism or build a run-local bundle
from selected baseline roots plus the CA. Do not accidentally replace all normal
roots with only the interception certificate.
[Certificate roles](https://docs.mitmproxy.org/stable/concepts/certificates/)
and [verification options](https://docs.mitmproxy.org/stable/concepts/options/)
inform these choices.

Environment helpers normalize uppercase/lowercase HTTP/HTTPS proxy variables,
remove conflicting `ALL_PROXY` variants, and set `NO_PROXY`/`no_proxy` deliberately.
Default bypass is `localhost,127.0.0.1,::1`; local integration tests override it.
Reject contradictory overrides rather than silently restoring a direct route.
Client trust adapters explicitly select `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS` or another verified mechanism; do not set every trust
variable indiscriminately. The consumer integration verifies WSS/client behavior.

| Policy | Meaning and initial rules |
| --- | --- |
| Routing bypass | Direct client connections via explicit `NO_PROXY` entries; invisible to sidecar. Immutable for the run. |
| TLS tunnel exclusions | CONNECT flows forwarded without decryption for exact hosts/ports or explicit DNS suffixes compiled into escaped engine patterns. Immutable for the run. |
| Capture selection | Intercepted traffic filtered by exact/suffix host, port, method and path prefix; exclusions win. No filter means all intercepted traffic **after capture is explicitly enabled**. Mutable. |

Hosts normally omit the sidecar unless requested. If present with recording off,
the sidecar still establishes/intercepts eligible HTTPS/WSS connections from the
start; it simply does not archive their payloads. Recording on/off changes
observation, not the TLS path. Capture changes cannot decrypt an already-tunneled
or direct connection. Some unencrypted
HTTP requests cannot use the same tunnel bypass; reject unsupported combinations
rather than claiming enforcement.
[Ignoring Domains](https://docs.mitmproxy.org/stable/howto/ignore-domains/)
documents the engine distinction. No public regex or payload-predicate filters
in the initial design.

## 6. Capture records and observation semantics

Schema `pdum.mitm.capture/1` is independent of engine and Codex schemas. This is
an observation archive, not a thread store or replay format. Preserve unknown
application JSON fields/events subject to the selected capture filters, with no
initial size-based omission policy.
Interpretation adds derived records; it does not replace base evidence.

Each record contains `schema_version`, `run_id`, `capture_revision`, `seq`, UTC
time, monotonic offset, `kind`, `connection_id`, optional `flow_id`, per-flow
sequence/direction, and explicit completeness. Assign sequence at observation,
before optional queue admission. It orders this worker's observations, not global
causality. Request/response share a flow ID; WS retains its handshake flow ID.

| Family | Content |
| --- | --- |
| `run.start`, `capture.boundary`, `run.end` | Versions, effective capture policy, revision boundaries and final status. |
| `connection.open`, `connection.close`, `tls.error` | Endpoints, protocol/TLS metadata and outcome; certificate private keys are not traffic records. |
| `http.request`, `http.response`, `http.end`, `http.error` | Method, URL, status, ordered duplicate-preserving headers, available trailers, sizes and completeness. |
| `body.chunk` | Captured byte segments, offsets and encoding; not packets or HTTP wire framing. |
| `body.json`, `body.jsonl`, `body.sse` | Decoded values/events with source span and encoding, produced off the forwarding path. |
| `websocket.open`, `websocket.message`, `websocket.close` | Direction, opcode, per-direction index, payload representation and close/completeness state. |
| `flow.snapshot`, `capture.gap`, `capture.error` | Late-start context, missing prefixes, losses, truncation, decoding and sink failures. |

Stream HTTP bodies from headers onward in both directions. SSE must become
visible before stream completion. Identity-returning callbacks preserve forwarded
bytes instead of the engine's normal full-body buffering.
[Streaming examples](https://docs.mitmproxy.org/stable/addons/examples/)
explain the callback mechanism. Expose engine omissions, such as unsupported
HTTP/1 trailers, in capabilities rather than claiming complete metadata.

When recording is enabled, preserve body bytes and complete WS message payloads
without initial payload caps, with binary bytes represented unambiguously (for
example base64). JSON, JSONL and SSE decoding adds convenient semantic records;
unknown fields, non-JSON text and binary content do not disappear merely because
a decoder does not recognize them. Invalid JSON is a decoding result, not lost
network evidence. A metadata-only capture option can reduce volume deliberately.

Initial decoding supports identity, gzip and deflate. Unsupported encodings retain
encoded bytes and a decoding marker while forwarding stays unchanged.
JSON assembly runs in the observer; JSONL/SSE emit incrementally. No preset decoder
size/expansion threshold discards otherwise valid evidence. Optional masking must mark
the representation as modified; the default does not claim sanitized evidence.

WS records contain reassembled messages, not original frames. After retaining an
immutable copy of the complete observation, clear engine message-history retention through
the pinned adapter without modifying the forwarded message. Test fragmentation,
compression and close/reconnect separately from JSON interpretation.

### Changes on already-open connections

Every callback reads current capture revision; recording is not frozen at flow
creation. Therefore controls affect existing HTTP streams and WebSockets.

- Enable emits a boundary, then a minimal `flow.snapshot` when an existing flow
  next produces an observation. Mark `partial_prefix=true`; do not invent missing
  bodies/handshake headers. Off-mode retains connection identity/counters and
  minimal context only, with no payload archive.
- A WS message belongs to the revision at its completed-message callback. It can
  include fragments received before enable; document that boundary. Disable
  before that callback prevents that entire message from being captured.
- An HTTP chunk belongs to its callback revision. Enabling mid-gzip/deflate cannot
  reconstruct the missing decoder prefix: report `decoder_unavailable_midstream`.
  Keep subsequent encoded bytes; derived decoding resumes at the next independently
  decodable body, or next valid JSONL/SSE boundary for identity data.
- Disable stops admitting content immediately and clears incomplete decoder state
  with a marker. Previously admitted records still drain; they are not silently
  discarded. Record last-old/first-new observation sequence boundaries.
- Filters/destination switches use the same boundary. Never split one WS message
  between sinks; long HTTP flows can intentionally span revisions.

This is control at an application observation boundary, not a promise to switch
on an exact network packet or visible model token.

## 7. Storage, monitoring and capture policy

**No initial capture-size limits.** Remove the earlier queue/payload/metadata caps,
decoder expansion thresholds and 256 MiB/run quota. Assume ample storage and
monitor the workload. Preserve complete observed payloads rather than recording
prefixes merely because they cross an arbitrary threshold. Rotation/chunking are
storage layout choices, never retention limits: a large record can span chunks or
exceed a segment's target size without truncation. Do not automatically delete
old evidence or disable recording after a preset volume.

Track captured/written bytes, pending records/bytes, oldest pending age, processor
latency/errors, available storage and sampled memory. Keep status available
independently of the sinks so a failed exporter cannot conceal its own failure.
Use counters and run/flow sequences to report actual loss, not an invented
losslessness guarantee. Optional host monitoring can alert on growth. The initial
implementation has no size-based queue admission policy, capture quota or
strict-recording mode that stops a healthy consumer. Later resource guardrails
need explicit review based on measured workloads.

Slow observers accumulate backlog, not forwarding backpressure. A failed sink or
decoder is marked unhealthy and its unavailable output is accounted for; base
capture and other healthy processors continue where possible. Disk exhaustion can
prevent writing diagnostics too, so control health must report failures even when
the archive cannot. A missing final manifest means unknown completeness. Deadlines
at shutdown may leave output incomplete; report pending/lost records explicitly.
No finite-memory system can promise an unlimited backlog without affecting the
process. This accepted first-version limitation must be measured and visible,
not hidden behind a tiny buffer/drop default or a false hard-isolation claim.

**Engine buffering remains separate.** Inspection of 12.2.3 shows WS
fragments/decompression buffered before the addon sees a completed message.
Clearing history does not remove the memory cost of a huge/incomplete message.
Measure/document this in realistic stress tests; host/container resources still
exist. Do not add post-message truncation as a supposed solution to pre-hook
buffering, or advertise adversarial-input isolation.
[WebSocket source](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/mitmproxy/proxy/layers/websocket.py)
supports this specific limitation.

Recording requires an explicit destination. Create a private run directory with
`manifest.json` and `events-000001.jsonl`, etc. Manifest begins `complete=false`,
contains versions and effective policy metadata, and is atomically replaced at close.
Only newline-terminated records are recoverable after a crash; report/ignore a
partial final line. Flush at least every second, on barriers and on close.
Successful local `flush()` includes `fsync`, not remote durability.

Do not silently delete old evidence or stop capture at an invented quota. Offer an explicit
inventory/prune utility restricted to closed runs with this schema, dry-run by
default; scheduling is a host concern. Keep requested captures after close but
delete CA/work state.

### Capture policy: useful evidence first

Recording is off until enabled with a destination, to avoid needless volume.
Once enabled, default to full observed application-level capture:
headers, bodies, unknown payloads and both WS directions. This may include API
keys, login messages and other sensitive content. Do not require another
`raw_local` mode, a secret-field registry, or separate consent for each field.
Metadata-only capture is a straightforward volume option.

Optional simple masking of known headers or configured fields is fine when it is
easy and useful. It is not a guarantee of anonymization, a condition for activating
a plugin/sink, or a reason to discard unknown messages. Record the active masking
options/revision so consumers know whether data was altered. Capture controls may
change these options without reclassifying archives through a security workflow.

Local and remote sinks follow the same operator-selected policy. Configuring a
destination is sufficient; no mandatory redacted-only export path or additional
export approval. Raw data may be sent to the operator's trusted observability
service. There is no silent upload to an unconfigured destination.

Keep captures and CA private keys out of Git and public CI artifacts. Review shared
summaries before publication. Routine status should report paths/counts rather
than entire credentials, but intentional internal captures are not publication.
A future lockdown mode can add stronger redaction/export policy without burdening
this trusted default.

## 8. Private control and acknowledgments

Versioned JSONL over inherited stdin/stdout, request IDs, 64 KiB message limit
and bounded readers are sufficient. This is private implementation detail behind
`SidecarHandle`, not an external client SDK. Capture payloads never use control
stdout. Parent drains bounded stderr; framing/version mismatch is fatal.

Commands: `status`, `configure_capture`, `flush`, `ping`, `shutdown`.
Serialize updates. Require `expected_revision` to reject stale writers without
changing state. Prepare/validate a new destination before advancing revision;
preparation failure leaves old policy intact. Startup-only changes return
`restart_required`. Destination preparation runs outside traffic callbacks, with
blocking filesystem operations offloaded and a deadline; existing forwarding
continues under the old revision until preparation succeeds.

`CaptureAck.boundary_seq` is the last observation under old policy; the next uses
the new revision. Acknowledgment means **applied**, not durable.
`drained_through_seq` is the accounted prefix at acknowledgment and can lag:
accounted means persisted **or explicitly omitted/lost**, with losses returned.
Do not confuse it with successful persistence.

`flush()` captures a barrier and waits within the drain deadline. Return barrier,
persisted watermark where meaningful, losses and `complete=false` for gaps,
pending work or sink failure. An update can take effect before its control request
times out: query status/revision rather than blindly retrying. Disable stops
admission before acknowledgment; call flush for old output accounting. No control
operation waits on disk/plugins inside a forwarding callback.

Inherited parent pipes need no authentication layer. An optional async FastAPI host
can map management requests to these methods using the same trusted-network stance;
lockdown policy is separate and later. No web framework or management listener is
required inside the generic sidecar.

## 9. Simple processors, discovery and remote output

Keep two interfaces distinct from arbitrary engine addons:

| Interface | Proposed operations |
| --- | --- |
| `RecordInterpreter` | Async `open(context)`, `interpret(record)`, `close()`; emit namespaced derived records/metrics linked to source sequence, never replace evidence or mutate traffic. |
| `RecordSink` | `open(context)`, `write(batch)`, `flush(through_seq)`, `close()`; async operations, typed failure and accepted/durable watermarks. |

These are ordinary trusted processors, not a general plugin runtime. Provide
explicit factory references and configuration through `open_sidecar`/launch
configuration. Because the engine is a child process, references must identify
factories importable there; do not promise to serialize arbitrary closures or
live host objects. Resolve/load the selected implementations in the observation
worker path, never from received network messages. Factory naming/configuration
syntax is still a small API-design decision.

Optionally discover installed metadata through `pdum.mitm.interpreters` and
`pdum.mitm.sinks` entry points for CLI listing/selection. Selected providers may
offer a Typer registration hook for namespaced options/subcommands; construct the
CLI before parsing and reject collisions. Programmatic explicit selection does
not require discovery. No automatic installation or activation of every installed
provider. The launcher or an adjacent integration package supplies any Codex
interpreter/preset, including usage/cost metrics; MITM remains domain-independent.

Deliver the hooks and small file/test implementations with local capture, not
after a large plugin-host milestone. A processor receives immutable observations,
never engine Flow objects, on its own async queue/task off the traffic event loop.
Fan out without awaiting remote delivery; synchronous work uses the observation
execution context rather than running in traffic callbacks. Errors and cooperative
timeouts disable/report only the failed processor; healthy sinks/forwarding remain
usable. Report undelivered sequences and pending work. Do not impose initial
payload or queue quotas, an extension-count limit, a worker per extension or a
new private IPC protocol per plugin.

This is cooperative isolation, not containment of arbitrary crashing or CPU-bound
code. Trusted processors must not block their async dispatcher; stronger process
isolation can be added for a demonstrated need. Cancellation/deadlines cannot
forcibly stop a noncooperative thread; document that limitation. No secret broker
or per-field authorization layer is needed. Derived records retain source IDs,
do not replace base evidence and cannot recursively feed interpreters.

Initial remote delivery is best-effort, with no automatic replay/retry spool or
exactly-once claim; a timed-out write may have reached its destination. Report
delivery uncertainty rather than promising at-most-once behavior by the remote
service. `(run_id, seq, processor_id)` provides a future deduplication key.

Ship local storage, a minimal test interpreter/sink and the extension contract
first. Optional Logfire or other exporters should be small adapters, not a remote
logging framework; do not import their dependencies for a local-only run.
Remote-only output requires a configured destination and implies no local durability;
raw or optionally masked capture may use it without another export gate. On a sink
switch, old queued records drain to the old sink while the new revision goes to the
new sink. Failed preparation is atomic; failed old flush is
reported loss, not rollback of already-applied policy.

## 10. Delivery and evidence

The [plan](../plans/mitm.md) has engine qualification, managed lifecycle/trust,
local capture/runtime control with simple processor hooks, optional exporters,
and launcher integration
gates. Local capture does not depend on Logfire, FastAPI or cloud storage.

Evidence reviewed **2026-10-12**, not rerun for this proposal:

- The imported [Spike 002 report](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/002-claude-traffic.md)
  and `experiments/spikes/002-claude-traffic/python/capture.py`: live Claude HTTP/SSE capture,
  bounded decoding and local WS checks; not this package's test suite.
- The imported [Spike 008 report](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/008-luna-websocket.md): installed Codex 0.162.1,
  mitmproxy 12.2.3, two bounded live Luna WSS turns. Not universal proxy coverage.
- `lean-agents/src/lean_agents/proxy/`: useful CA/environment precedent, but its
  synchronous wrappers, startup sleeps and broad overlays are not carried forward.
- Locally installed mitmproxy **12.2.3**: Python metadata `>=3.12`, startup
  sequencing, listener inspection and pre-hook WS buffering. Official docs/source
  links above qualify individual implementation choices.

The trust/default and no-initial-caps stance is agreed; detailed interfaces still need
review. Major risks are engine churn,
client-specific proxy/trust behavior, pre-hook WS memory, lossy capture under
load and maintaining a thin adapter around a fast-moving engine. Failed implementation gates must
revise the proposal, not be presented as solved.
