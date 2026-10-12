# Codex launcher — architecture proposal

**Package:** `habemus-papadum-codex-launcher` (`pdum.codex_launcher`)

**CLI:** `pdum-codex`

**Status:** partially implemented; see [current capabilities](../implementation-status.md)
and [validation policy](../testing.md). The [design principles](../design-principles.md)
record the agreed trust/config stance and lifecycle, inspection and CLI direction.
Detailed APIs and compatibility remain proposals. This supersedes earlier
defensive defaults, capture caps and plugin-worker requirements.
See the [implementation plan](../plans/codex-launcher.md).

## Executive decisions

- Profiles are self-contained directories. Python takes a directory; the CLI
  resolves names. Keep native Codex configuration native, including unknown fields.
- Launcher metadata covers only executable selection, environment, launch and
  integration concerns; do not maintain a second native configuration schema.
- Persistent and temporary profiles are first-class. Copy settings directly;
  make credential reuse convenient and warning-based, not permission-gated.
- Own one app-server per profile using `asyncio` and a machine-local lease.
  Run foreground/application-owned; record PID/process identity for easy status
  and cleanup. No daemon or attach-to-existing mode initially. Initial hosts are
  macOS/Linux on local filesystems.
- Default sandbox off, approval prompts off and all-interface TCP listeners.
  Trust clients inside the operator's network; no required grants or timed reconnects.
- Support Unix and WebSocket endpoints. The inspected Unix transport is
  WebSocket-over-Unix, not raw JSONL. Verify the selected executable.
- Keep raw-protocol forwarding thin. Copy messages to an independent async
  inspection/export path; observer failure must not stop healthy forwarding.
- No MITM sidecar by default. When selected, interception starts at launch;
  recording may start off and be enabled later. No initial capture size quotas.
- Export a reusable Typer CLI and explicit processor hooks. An optional FastAPI
  management adapter can reuse the runtime; defer daemon mode, cloud migration,
  lockdown and a general thread SDK.

This page describes the wider target; the implementation-status page owns current
command/API availability and validated limitations.

## 1. Responsibilities and implementation boundaries

| Component | Responsibility | Does not own |
| --- | --- | --- |
| `profiles` | Paths, small launcher-metadata validation, atomic creation/copying and temporary state | Native schema maintenance or credential renewal |
| `auth` | Credential-source configuration and isolated operator login | Client authentication RPC handling or a new OAuth implementation |
| `runtime` | Binary checks, lease, environment, subprocess, readiness, cleanup | Thread/turn semantics or automatic turn retries |
| `relay` | One-to-one forwarding and asynchronous message copying | Client authorization machinery, upstream login, RPC rewriting or tenant isolation |
| `observation` | Processor selection, independent inspection tasks, local output and optional metric/export hooks | Blocking forwarding, rewriting traffic or treating missing usage as zero |
| `integrations.mitm` | Codex-specific proxy/trust adapter and optional interpretation plugin | Generic proxy engine/capture implementation |
| `cli` | Exported Typer app/factory, argument resolution, interview, human/JSON output and optional provider commands | A second implementation of library behavior or hidden process startup on import |

Use Typer for the CLI, plus `asyncio`, typed dataclasses and `tomllib`.
Other proposed small dependencies are `platformdirs` for locations, a round-trip TOML
editor for the few requested edits, and the modern asyncio `websockets` API. Select compatible
versions during implementation, not in this proposal. MITM is an optional package
extra; importing or running the launcher without it must work. FastAPI and Logfire
are optional adapters, not core import requirements or prerequisites for local use.

## 2. Profile identity, selection, and disk layout

### Locations and selection

The default root is `platformdirs.user_data_path("pdum-codex", appauthor=False) /
"profiles"`: conventionally `~/Library/Application Support/pdum-codex/profiles` on
macOS and `$XDG_DATA_HOME/pdum-codex/profiles` on Linux. A library call never consults
this default; it receives a `Path`.

CLI selection is deliberately exclusive:

| Input | Resolution |
| --- | --- |
| `--profile-dir /absolute/path` | Exact directory; cannot combine with either selector below |
| `--profile NAME` | Name under the default root |
| `--profiles-dir ROOT --profile NAME` | Name under that explicit root |
| `profile list [--profiles-dir ROOT]` | Enumerate that root, without selecting a profile |
| `launch --temp` | New private temporary profile; cannot select a persistent target |

There is no implicit `default` profile for launch, login, or mutation. Names match
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, excluding `.` and `..`; no separators or traversal.
Explicit paths may contain spaces. Resolve existing path aliases before locking;
use the resolved directory's device/inode as an additional identity check. Reject
ambiguous metadata/lock aliases that could create competing ownership. Do not
silently create a missing profile while launching it. These checks prevent path
collisions and unintended writes, not every theoretically untrusted filesystem arrangement.

```text
<profile>/
  launcher.toml             small launcher-owned configuration
  codex/
    config.toml             native Codex model/provider/permission settings
    auth.json               native file-backed credentials when used
    skills/                 explicitly imported profile-local skills
    ...                     Codex-owned history, databases, caches and other state
  home/                     isolated HOME and XDG configuration roots
  work/                     neutral initial working directory
  runtime/
    lease.lock              persistent lock inode; never unlink to unlock
    owner.json              atomic, non-secret ownership journal
    control.sock            private launcher-control socket while running
    runs/<run-id>/           run manifest and opt-in diagnostics/captures
```

Create directories with mode `0700` and files with `0600`. Profile identity is the
directory, not a copied UUID; cloned directories are new profiles. Native sockets
can use a short private runtime directory when platform socket path limits would
be exceeded; store the resolved path in the run record, not a predictable `/tmp`
filename. Network filesystems, cross-machine leases, Windows, and bind-mount aliases
that cannot be identified reliably are outside the first support contract.

### Configuration ownership

Use a small `launcher.toml` with `schema_version = 1` only for fields we own:
executable selection, process environment, selected authentication setup,
endpoints/timeouts and optional MITM configuration. Validate those fields for
typos/incompatible values, not native Codex config against a second schema.
Do not introduce a configuration inheritance/merge framework.

Illustrative launcher metadata, not a final API or Codex syntax:

```toml
schema_version = 1

[executable]
path = "/absolute/path/to/codex"

[launch]
transport = "websocket"
bind = "0.0.0.0"
startup_timeout_seconds = 30
shutdown_timeout_seconds = 15

[mitm]
enabled = false
```

Model, reasoning, MCP, provider and permissions stay in native `codex/config.toml`.
Copy that file verbatim when possible. Preserve unknown keys; use a round-trip
TOML editor or the native config interface for small requested edits. Codex
validates its own configuration.

Record observed binary version/digest and effective launch choices. Store helper
or environment/file references only where needed, avoiding duplication of values
already in native config. Relative launcher paths resolve against the profile.
No launcher secret-classification, Origin-policy or grant tables.

Show state-location/auth overrides without routinely dumping credentials. New
profiles start with sandbox off and approvals off unless the operator supplies
different native settings. Do not continuously regenerate config, police native
changes or revert edits made through clients.

## 3. Creation, import, and temporary profiles

### Creation and copying

`profile create NAME` uses staging and atomic rename; an existing target is an
error, not permission to merge/overwrite state. The terminal interview covers the
source, executable, model, auth and launch choices with a short file/category
preview. Non-interactive configuration/flags do not prompt or substitute models.

Selecting a source copies its native configuration, skills and launcher choices
by default. Categories such as `model`, `skills`, `mcp`, `permissions`,
`environment`, `executable` and `native-config` are optional convenience filters.
Their shortcuts touch only the small known subset we edit; whole-file copying is
the forward-compatible escape hatch. Preserve unknown keys, MCP environment
values, native credential literals/references and helper commands.

Explicit creation values override copied ones; report overrides without another
approval ceremony. Preview files/categories rather than every value, and note
that config may carry authentication or shared external references. No per-field
auth opt-in, secret scanner, schema classification or disabling of copied services.
Persistent creation can copy `auth.json` with one `--copy-auth` switch and a
warning. Independent login for long-lived profiles is available, not mandatory.

A settings clone excludes sessions, caches, databases, locks, sockets, logs and
captures. Do not write to the source. Copy profile-local files instead of linking
destination state back to them. Preserve intentional external references with a
shared-resource warning. Cyclic/dangling symlinks or ambiguous destinations are
copy errors; offer explicit materialization when needed, not a security interview.

### First-class temporary profiles

```sh
pdum-codex launch --temp --model gpt-6-luna
pdum-codex launch --temp --from-profile research
pdum-codex launch --temp --clean
pdum-codex launch --temp --from-profile-dir /private/profiles/research --no-auth-copy
```

Recommended convenience behavior:

| Selection | Initial state |
| --- | --- |
| `--temp` | Fresh native settings plus available file-backed auth from the caller's normal Codex home, with one warning. |
| `--temp --from-profile NAME` / `--from-profile-dir PATH` | Source settings/skills/launcher choices and available `auth.json`, with one reuse warning. |
| `--temp --clean` | No source settings or credentials; conflicts with source/borrowing options. |
| `--no-auth-copy` | Omit the separate `auth.json` copy; does not scrub authentication already present in copied native config. |
| `--borrow-auth-from current/source/PATH` | Override the convenient auth-file source with one choice, without another consent gate. |

Use `--exclude CATEGORY` to narrow a clone. These are settings clones, not thread
snapshots. If an auth file is missing, report it; copied API/helper configuration
may still work. If no usable auth remains, give a direct next step, not an account
search. Library results expose warnings as data; the CLI prints them once without
blocking quick or automated use.

Resolve `current` from the caller's original `CODEX_HOME` or `HOME/.codex`
before constructing the child environment. Snapshot a regular file into the
destination with ordinary private-file permissions. Never symlink auth back,
write back, or initiate source login/refresh. Codex may refresh its destination
copy. A copied refresh token creates another renewal owner and can invalidate
either session: an accepted warning-level tradeoff, not a launch prohibition.
Do not build a broker just to remove that tradeoff. Keyring/external credentials
need their supported login/reference path; do not fabricate a missing auth file.

Create a unique temporary directory outside the checkout; remove it only after
app-server, relay and MITM stop and pending output flushes. `--keep-temp` retains
and reports it. Failed cleanup reports retained state, not secure erase.
`temp list`/`temp prune` operate on known profiles and acquire their lease,
refusing live/uncertain owners instead of deleting by filename pattern.

After launch releases its lease, cleanup reacquires it, marks the profile disposed,
then closes the lease before removal. Launch checks that marker after acquisition.
If another owner won the race, retain/report the directory. This prevents accidental
state reuse/deletion, not trusted-user access.

## 4. Library and CLI surface

Proposed Python boundaries use paths and immutable request/result objects:

| Interface | Result and behavior |
| --- | --- |
| `create_profile(directory, specification)` | Async atomic creation; no interview |
| `inspect_profile(directory)` | Paths/config sources and state summary; no credential refresh or routine secret dump |
| `list_profiles(root)` | Per-directory summaries; one malformed profile does not hide others |
| `login_chatgpt(directory, options)` | Async isolated Codex CLI login; profile lease required |
| `temporary_profile(specification)` | Async context manager; exposes its resolved directory |
| `launch(directory, options)` | Async context manager yielding `RunningAppServer` after readiness |
| `RunningAppServer.endpoint` | Typed Unix/WS endpoint, not a guessed URL string |
| `RunningAppServer.wait()` / `aclose()` | Structured exit result / idempotent bounded shutdown |
| `RunningAppServer.status()` | Lifecycle, process identity, endpoint, optional capture health; no tokens |

The library does not install global signal handlers; the CLI translates SIGINT and
SIGTERM into cancellation. Large imports/hashing and blocking filesystem operations
run in bounded worker threads; subprocesses use `asyncio.create_subprocess_exec`,
never shell command interpolation. All cleanup paths must work under cancellation.

```sh
pdum-codex profile list
pdum-codex profile create research
pdum-codex --profile research profile show
pdum-codex --profile research profile validate
pdum-codex --profile research auth login-chatgpt
pdum-codex --profile research auth configure-api-key --env OPENAI_API_KEY
pdum-codex --profile research auth configure-api-federation --helper /trusted/token-helper
pdum-codex --profile research auth status
pdum-codex --profile research launch
pdum-codex --profile-dir /private/profile launch --dry-run
pdum-codex --profile research status
pdum-codex --profile research stop
```

`launch` stays in the foreground. No daemon/detach or attach-to-existing mode
initially; tmux, Docker or the caller can provide external supervision. The Python
async context manager owns the process lifetime. Keep start/status/stop operations
separate enough for future hosts without implementing a service manager now.
`--json` emits
structured lifecycle/results without dumping credentials; diagnostics go to stderr.
Show login ceremony data to the operator rather than routinely persisting it.
Deliberate protocol captures are a separate output.
`launch --dry-run` resolves config and binary but neither loads secret values nor
starts a sidecar/app-server. Edit/rename/delete are deferred rather than disguised as
unsafe filesystem operations; `profile show` gives paths for deliberate offline edits.

### Composable Typer CLI and processor selection

Propose `pdum.codex_launcher.cli.app` and `create_app(...)` as public mounting
surfaces. The standalone `pdum-codex` entry point invokes the same app another
Typer application can mount as a subcommand. A factory returns a fresh command
tree, so different hosts can register different provider options without mutating
global CLI state. Importing/mounting does not start processes, install signal
handlers or run an event loop. CLI execution bridges to the existing async API;
applications with an event loop call that API directly.

Callers can supply observation processors explicitly at launch. Saved profiles
and CLI arguments use selected factory references/names plus ordinary configuration,
not serialized live objects. The CLI can list installed providers through optional
entry-point metadata; discovering them does not activate their processors. Selected
providers may register namespaced options/subcommands when the app is constructed,
before argument parsing. Reject command/option collisions clearly. Plain explicit
configuration works without discovery, and no shared root `pdum` CLI is required.

Use small filesystem and test processors to exercise this boundary initially.
Logfire or Grafana-compatible metric exporters can be separate optional adapters;
do not build their backend, retries or dependency graph into the launch command.

## 5. Binary selection, state isolation, and permissions

Creation precedence: explicit executable, copied executable, then `PATH`.
Resolve/store an absolute path and record observed version/hash. Missing binaries
fail; changed binaries warn and record their new identity rather than demanding
security approval. Offer exact-version/digest pinning for requested reproducibility.
`--executable PATH` overrides one run; `profile executable set PATH` updates the
stopped profile. A dotslash wrapper may be selected; record its actual artifact
where possible, because its own hash does not identify the binary it runs.
Automatic binary distribution is outside v1.

Environment controls prevent accidental home/credential/proxy reuse. A clean
baseline uses profile-local `HOME`, `CODEX_HOME`, XDG/temp paths, explicit PATH
and locale values; add profile settings, one-run overrides, then auth/MITM overlays.
Report conflicting process-owned home/proxy values. An `inherit` mode is available
without a permission ceremony. Copied credential references do not populate a
clean child's environment automatically: report known missing inputs or propagate
the native failure, then let the operator inherit/supply them. Do not scan all
native fields to infer a secret allowlist.

Start in profile `work/`, not an accidental caller repository. The fresh minimal
preset avoids importing normal user MCP/plugins/skills; a settings clone honors
its copied integrations instead of disabling them as a precaution. Qualify actual
loaded state for the selected binary. Project/system settings can still apply.
This is state isolation, not a security sandbox.

**Default sandbox is off; approval prompts are off.** Use the binary's native
unrestricted/no-approval settings for new profiles unless explicitly overridden.
Display actual settings and managed-policy/binary incompatibilities; do not pretend
unrestricted operation is active or patch the installed CLI/host policy. Thread/turn
overrides remain native behavior. Do not rewrite RPCs to enforce a continuing policy.

Exposed TCP binds default to `0.0.0.0`, with configurable addresses/tested IPv6.
No compulsory client tokens, Origin allowlists, TLS layer or connection-age limit.
Unix/loopback may still be internal wiring. Lockdown is a separate future mode.

## 6. Lease and asynchronous process lifecycle

### One managed owner, including an orphaned app-server

On macOS/Linux, acquire a nonblocking exclusive `flock` on the persistent
`runtime/lease.lock` inode. All launcher mutations, including login, imports into an
existing profile and executable/auth edits, use this lease. Inspection is read-only.
Do not implement ownership as `exists(lockfile)`, a PID file, or delete-to-unlock.

The launcher retains the lock's open file description and passes a duplicate lease
descriptor to the Codex child through `pass_fds`. Consequently, an abruptly killed
launcher must not release profile ownership while its app-server survives. This
behavior is a **binary/platform compatibility gate**, not an assumption: wrappers
and executables that close inherited descriptors need an explicit guardian adapter
or are rejected for managed launch. Do not advertise orphan-safe support until the
parent-SIGKILL test passes for that execution chain. The descriptor carries no
credentials and must not be passed to unrelated helper or MITM processes.
Release ownership by closing this process's descriptor, not by `LOCK_UN` on the
shared open file description: explicit unlocking could release a surviving child's
lease too. The journal/live-process check still blocks replacement if an unexpected
runtime descriptor closure is detected; such a run is not considered qualified.

Before spawn, write a run nonce and owner identity; after spawn, atomically record
child PID, process birth identity, executable identity and process-group identity.
Expose these through `status`/`--json`, with the profile, endpoint and journal path,
so an operator can locate and clean up the server without hunting through processes.
Duplicate launch reports this information and the `stop` command; it does not attach.
The lease is authoritative; the journal is diagnostic and supports recovery. If a
crash happens between spawn and journal update, an inherited busy lease still blocks
another launch; incomplete owner metadata is not permission to steal it. PID reuse
or unverifiable ownership produces `OwnershipUncertain`, never a blind `kill(pid)`.

`stop` first asks the private launcher control socket. Orphan recovery is explicit:
validate current UID, process birth identity, binary/run identity and matching
endpoint before signaling the verified owned process. If identity cannot be proven,
report manual recovery instructions without killing anything. Never unlink the lease
inode while a process could hold it. A free lease plus proven-dead owner permits
stale journal/socket cleanup. Children retaining the descriptor can prolong a lease;
report that condition rather than falsely declaring it stale. This is not a defense
against a malicious same-user process or someone bypassing the launcher entirely.

### State machine

`NEW → LEASED → PREPARING → STARTING → READY → STOPPING → CLOSED`; any stage may
enter `FAILED`, which still performs reverse-order cleanup. A run identifier is
assigned before resources are allocated. Use an `AsyncExitStack` and a task group
for drainers, process wait, relay and optional sidecar health; record which resources
actually reached each stage so partial startup is safe.

1. Validate profile/binary, acquire lease, prepare isolated directories/environment.
2. Start MITM if configured and await its ready handle before obtaining child env.
3. Spawn Codex in a new process group with continuous bounded stdout/stderr drainers.
4. Connect to the expected native endpoint, initialize a short-lived private probe,
   send `initialized`, and perform a read-only protocol check. Close that connection;
   do not reuse its initialized session for a client. No model call or login is needed.
5. Start optional relay, publish endpoint metadata, then return `READY`. Readiness
   means a speaking app-server, not working credentials or model entitlement.
6. On close, stop accepting relay clients, close relay connections, terminate the
   owned Codex process group with SIGTERM, await the configured deadline, then use
   SIGKILL only for verified owned survivors. Reap and finish drainers.
7. Flush/close MITM, remove owned sockets, finalize run status, then close the parent
   lease descriptor. The enclosing temporary-profile context performs its separate
   disposal check. Preserve failures and incomplete-output flags in the result.

Unexpected child exit closes relays and the sidecar. Unexpected forwarding/control
failure of a configured MITM stops Codex; there is no automatic direct-network
fallback. Capture degradation alone follows the MITM capture policy and is surfaced
without pretending forwarding failed. Cancellation is re-raised after bounded cleanup;
cleanup errors are attached, not allowed to erase the original failure. No automatic
app-server restart or turn replay in v1.

## 7. Upstream OpenAI authentication

Authentication is shared by an app-server, not a tenant boundary between its threads.
These modes concern upstream inference, not permission to connect to the relay.
They are setup conveniences, not a mandatory classification of every native
provider. An existing native configuration may be launched unchanged without the
launcher understanding its authentication scheme. Only rewrite provider settings
when the operator requests that setup operation, not on every launch.

| Mode | Setup | Credential/renewal owner | Persistence |
| --- | --- | --- | --- |
| `chatgpt` | `auth login-chatgpt` runs the chosen `codex login` with isolated home/store | Codex | Profile's file-backed credentials |
| `api_key` | Reference one operator environment variable or private file | Operator/secret manager rotates; restart child to reread | Reference only in launcher config; key in child environment |
| `api_federation` | Trusted executable gets workload identity and exchanges it for an API token | Helper obtains fresh tokens; Codex invokes/caches helper output | Non-secret helper configuration; no copied refresh token |

ChatGPT login owns the same lease as launch, so an operator must stop the profile
before running launcher login again. Browser/device ceremony support follows the
selected binary's capability; a login URL is not successful login. Cancellation
stops the login process without touching the developer's ordinary home.

The API-key convenience setup uses a distinct custom Responses provider with `env_key` and
`requires_openai_auth=false`, rather than assuming stock app-server consumes an
`OPENAI_API_KEY` shortcut. Read the chosen reference at launch; do not write the
secret into additional config, argv, manifests, or routine diagnostics. Existing
copied native credential values remain native; no secret scrubber is implied. Environment
secrets can be inherited by Codex tools, so this is not isolation from the agent.

**Federation means API-platform federation**, mapping to an API project service
account, not native managed-ChatGPT Codex WIF. The launcher configures a distinct
Responses provider using `auth.command`, `args`, `cwd`, `timeout_ms` and
`refresh_interval_ms`. The first contract delegates identity acquisition/exchange
to an operator-supplied trusted executable; it does not implement every cloud SDK.
No shell interpolation. Its stdout contains only a bearer token. Avoid needless
credential dumps on stderr because Codex can include helper errors in diagnostics;
deliberate internal debug capture is allowed and is not public evidence.

Recommend a 25-second helper timeout and 60-second refresh interval only when the
helper guarantees at least 120 seconds of remaining token lifetime. Validate the
chosen lifetime/interval relationship instead of treating those numbers as universal.
Codex's inspected refresh is demand-driven and caches helper output; it is not a
guaranteed background refresh timer. Do not combine helper auth with `env_key` or
Codex-managed OpenAI auth. AWS acquisition, real API exchange and renewal on a
long-lived upstream WebSocket are explicit integration gates, not proven by a local
dummy-helper test. Select HTTP/SSE for the first federation compatibility profile;
enable WebSocket capability only after the live renewal/reconnect gate passes.
The model name alone does not decide the upstream transport.

**Client-initiated authentication has no special launcher handling.** The relay
forwards account requests, responses, callbacks and notifications like other RPCs,
including server requests requiring a client response. It neither injects logins
nor answers external-token refresh requests. Codex's selected provider still
determines whether a client login affects inference. A client can change the active
identity for the shared process; report config/auth state without treating the
profile's initial mode as an enforcement rule. Restrict clients accordingly.
Do not dump account secrets into routine status. Deliberately enabled protocol
recording may retain account payloads under the trusted capture policy. Optional
masking must not alter forwarding.

## 8. Native endpoints and browser relay

The client-facing WebSocket listener defaults to all host interfaces (`0.0.0.0`).
Another bind or a Unix endpoint is selectable. Distinguish bind from connectable
advertised address; a remote client uses a selected host address, not a wildcard.
Native Unix framing is WebSocket-over-Unix, not JSONL.

A Codex binary may require auth for non-loopback native listeners or reject browser
Origin headers. Where needed, provide the trusted network/browser endpoint using
a thin relay to a native Unix or loopback backend. Honor backend requirements on
that internal connection and show the actual frontend/backend layout. A requested
direct native mode reports its requirements instead of silently disabling them
or changing mode. This is transport compatibility, not a second client-login system;
verify the selected binary rather than requiring a fork.

Use one upstream WebSocket per downstream connection. Clients initialize their
own sessions; no shared initialized connection, multiplexing, ID rewrite or replay.
Preserve message contents and directional order. Framing, compression, ping/pong
and closes are transport-local. Use normal transport backpressure for the actual
destination, never recorder backpressure. Do not introduce launcher message-size
ceilings as capture policy; configure library defaults deliberately and report
unavoidable native/backend limits. A real transport failure closes the affected
connection with a reason, not silent RPC loss or automatic reconnection/replay.

Trusted browser clients use ordinary `new WebSocket(endpoint)`. No launcher
capability, Origin allowlist, grant file, token subprotocol or 15-minute expiry.
The separate backend handshake omits browser Origin/cookies as needed; do not
blindly forward transport headers. Healthy connections may last as long as needed.
Keepalive/failure detection must not become an arbitrary idle or maximum-age cutoff.

Network clients can use the full native protocol, including account/config changes.
The operator's network is the access boundary. Optional TLS/restrictive binds can
be chosen, but complete lockdown is deferred. HTTP CORS for any later HTTP routes
is separate compatibility configuration, not authentication.

### Inspection-only observation stream

Treat the relay as a tap, not a protocol controller. For each selected message,
copy an immutable observation containing payload, run/connection identity,
direction, sequence and timestamp, then enqueue it without awaiting an observer.
Forward the original message unchanged. No JSON parsing, metric extraction,
filesystem access or remote export belongs on the forwarding path. An observation
means the message was seen, not that its peer accepted it; keep delivery/close
outcomes distinct when available.

Use an independent asynchronous dispatch path with a queue/task per selected
processor. Slow sinks do not gate sending or unrelated processors. Offload blocking
file writes or synchronous exporters from the relay event loop. Catch/report
processor failures; disabling a failed observer must not disconnect healthy clients
or stop Codex. Do not add a process per plugin initially. Trusted plugins must
cooperate with the execution contract; a blocking CPU loop can still affect the
shared process, so do not claim hard resource/fault isolation.

Recording/export are unselected by default. A metrics processor can run without
a local archive, and a file processor need not depend on remote observability.
Enabled capture preserves complete observed messages, including unknown methods
and account payloads, without initial payload caps, truncation thresholds, queue
admission quotas or per-run storage limits. Monitor bytes, queue depth/age,
processor latency, storage and errors. Real disk failures, unfinished shutdowns
and omissions are explicit; no finite machine can guarantee unlimited retention.
Future guardrails need a separate decision, not an arbitrary default hidden in
this implementation. Recording failure never opts the agent into a strict-stop mode.

Processors may emit derived records and metrics alongside the untouched message
stream. Codex-aware processors live here or in an adjacent integration package,
not the generic MITM core. Examples are input/output/cached-token usage, context
observations and estimated cost for a configured pricing table. Include source
message/sequence, thread/turn identifiers where present, units and pricing/model
provenance. Determine incremental versus cumulative usage before aggregating;
do not double-count repeated terminal totals or invent missing usage/cost values.
Metric interpretation is read-only and must never inject app-server requests.

Optional simple masking affects only observer output and is labeled; schema-wide
redaction is not a prerequisite. Captures may contain tokens and belong in trusted
destinations, not Git/public artifacts. Configured local/remote processors receive
the same data without a second export approval. Start with file/test processors
and hooks; a small Logfire or Grafana-compatible exporter can be added independently.

## 9. MITM integration, control, and deferred services

The [MITM proposal](mitm.md) owns the canonical generic contract. The launcher uses
`open_sidecar(config)` as an async context manager; after readiness, the handle's
`connection` supplies `proxy_url`, `ca_cert_path`, and `run_id`. A launcher-owned
Codex adapter chooses the tested proxy/trust environment overlay and rejects
collisions. No global proxy change or certificate installation. Local relay/native
endpoint connections must bypass upstream proxy discovery explicitly.

Three launch choices are explicit:

| Choice | Behavior |
| --- | --- |
| No sidecar (default) | No interception process, CA or proxy overlay. Later interception requires a new launch. |
| Sidecar, recording off | Configure proxy/trust before starting Codex. Eligible HTTPS/WSS traffic is intercepted from connection establishment, but no payload archive is kept. |
| Sidecar, recording on | Same network path, with selected observations sent to configured processors/destinations. |

Recording-off does not mean opaque TLS tunneling: the interception and trust setup
must already exist if later recording is to inspect an established encrypted
connection. Explicit tunnel exclusions remain outside that capture capability.
No claim of retroactively intercepting a direct or excluded connection is made.

`status()`, `configure_capture(change, expected_revision=...)`, `flush()`,
`wait_failure()` and `aclose()` are the sidecar control surface. The launcher passes
through revisioned capture controls without inventing another capture schema.
Sidecar defaults remain recording-off; enable/disable applies to already-open
connections according to MITM's event-boundary and partial-capture contract. Fatal
forwarding/control failure and capture sink degradation are different statuses.

Initially the local launcher control socket exposes `status`, `stop` and capture
status/configuration with bounded versioned requests. It is not the app-server
RPC endpoint and has no grant/revoke service. An optional FastAPI adapter is a
reasonable small follow-on: async status/stop/capture operations delegate to the
existing owner, never blocking request handlers or launching a second supervisor.
It uses the same trusted-network defaults and remains optional for CLI/library
use. Lockdown access policy belongs to a separate later design.
Cloud snapshots/restoration need a separate design: quiescent
consistency, native databases/history, which credentials/state to include, external
executable references and restore ownership.
Neither remote home upload nor thread-storage replacement is part of v1.

## 10. Failure contract, evidence, and remaining gates

Library failures carry a stable code, lifecycle stage, run ID if assigned, and a
actionable message. Proposed codes include `InvalidProfile`,
`ProfileBusy`, `OwnershipUncertain`, `BinaryMismatch`, `UnsupportedCapability`,
`CredentialUnavailable`, `StartupTimeout`, `ChildExited`, `SidecarFailed`,
`RelayFailed`, and `CleanupIncomplete`. Avoid complete credential/environment dumps
in routine errors; detailed local diagnostics and deliberate captures may retain
upstream payloads. No generalized
secret-free-error detector is required. CLI exits: 0 success, 2 invalid arguments/config,
3 busy/uncertain ownership, 4 unsupported binary/capability, 5 startup/auth failure,
6 runtime failure, 7 incomplete cleanup; signal exits follow normal 128+signal
conventions after cleanup. Do not report a ready endpoint after startup failure.

This proposal adds no live observations. Evidence was checked on 12 October 2026:

- Official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
  describes initialization and account RPCs; use the selected executable's generated
  schema for implementation rather than relying on a moving documentation page.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  documents native provider/environment settings. Reserved launcher overrides still
  need a real isolated-config inventory test for each supported binary.
- [API workload identity documentation](https://developers.openai.com/api/docs/guides/workload-identity-federation)
  distinguishes API Platform service-account federation from managed ChatGPT Codex
  federation. Only the API-platform route is selected here.
- Local source pin `6c372fbef45f730b6d8aa727b0ec8332365588db` was inspected in
  `agent-spike/vendor/codex`: [transport parser](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-transport/src/transport/mod.rs),
  [Unix WebSocket transport](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-transport/src/transport/unix_socket.rs),
  [provider validation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/model-provider-info/src/lib.rs),
  and [helper refresh](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/external_bearer.rs).
  The local checkout contains a separate browser-Origin experiment; this proposal
  does not require that patch or assume it exists in the installed binary.
- Prior local spike reports used installed `codex-cli 0.162.1` independently of that
  source pin: 003 checked isolated configuration, 005 checked dummy helper renewal
  over HTTP/SSE, 008 observed live upstream WebSockets, and 013 exercised browser
  Origin behavior. These are historical evidence, not tests of the new packages.
  The reports are preserved under `experiments/docs/`; see the
  [research index and import notes](../research.md). The vendor checkout itself
  was not copied; its pin and source patch remain reproducible through the import's
  vendor instructions.

The blocking implementation gates are inherited-lease behavior, exact native
transport/readiness compatibility, loaded-state isolation, loss-accounted capture,
live proxy routing, and API-federation renewal. Do not convert a design choice into
a supported feature until its [plan acceptance criteria](../plans/codex-launcher.md)
pass. The original proposal used source inspection and prior spikes; subsequent
package tests and live validation are recorded in the
[implementation status](../implementation-status.md).
