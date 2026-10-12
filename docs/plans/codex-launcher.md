# Codex launcher — implementation plan

**Status:** delivery roadmap. See [current status](../implementation-status.md) for
the implemented subset and remaining gates; stages are not all complete. The
[trusted-operation principles](../design-principles.md) are agreed: no sandbox or
approval prompts by default, all-interface TCP listening, thin native config,
warning-based credential reuse and no mandatory client grants/connection expiry.
Foreground/application ownership, PID-aware cleanup, a thin asynchronous inspection
tap, no-sidecar defaults, no initial capture caps and reusable Typer CLIs are also
agreed. Detailed API/compatibility gates remain proposals.
This plan implements the [launcher architecture](../specs/codex-launcher.md).
The [shared rollout](implementation.md) coordinates the two packages.

## Delivery sequence

The first useful slice is a persistent or temporary isolated profile, predictable
auth reuse/selection, and one reliably owned app-server. Relay, MITM and management build
on that owner rather than each starting a competing process supervisor.

| Step | Dependency | Deliverable |
| --- | --- | --- |
| L0 | Architecture review | Binary/platform evidence and compatibility matrix |
| L1 | L0 basic compatibility | Thin profile storage/copying, executable identity |
| L2 | L1 | Clean environment, upstream-auth configuration and isolated login |
| L3 | L0–L2 | Async lease/process lifecycle and native endpoint |
| L4 | L1–L3 | Disposable profiles and convenient warning-based auth copying |
| L5 | L3 | Transparent browser/native relay, async inspection hooks and file/test processors |
| L6 | L3 and MITM ready contract; L5 only for relay capture | Optional sidecar integration and runtime capture control |
| L6a (optional) | L3/L6 management surface | Small async FastAPI adapter over the existing owner |
| L7 | L2–L3 | Real API-platform federation renewal qualification |
| L8 | L4–L7 | Release-quality documentation, compatibility and failure checks |

L7's helper configuration can be designed in L2, but no production federation claim
is made until L7 passes. MITM implementation can run in parallel through the agreed
boundary; L6 does not need to wait for the optional relay. No automatic package
release is included; releases remain human-operated.
When native direct access cannot satisfy the trusted network/browser endpoint,
L5 supplies that frontend before the default launch path is considered complete;
an L3 private backend alone is only a foundation, not the finished network default.

## L0. Establish the compatibility gate before choosing shortcuts

Record selected Codex path, version, hash, actual execution chain, platform,
generated protocol schema and source revision where available. Probe only private
temporary directories with an allowlisted environment. Never use the developer's
normal home or force token renewal as a compatibility test.

Acceptance:

- Verify the requested native Unix/WS transport and framing with initialize/read-only
  requests. Test Unix path-length handling. Confirm startup does not attach to an
  unrelated pre-existing daemon or reuse the wrong home.
- Verify passing a locked descriptor through the actual executable/wrapper chain:
  kill the parent with SIGKILL, prove the surviving child prevents another launch,
  stop the verified child, and prove ownership can then be acquired. Repeat on
  macOS and Linux; reject unsupported chains rather than weakening the invariant.
- Inspect only the native features the launcher actually uses: state/config
  overrides, unrestricted/no-approval settings, helper fields, native listener
  requirements and file auth. Verify any backend/relay wiring needed for a trusted
  all-interface endpoint; do not impose a launcher authentication system.
- Preserve unknown native config rather than requiring an exhaustive per-version
  schema. Unsupported requested features produce a clear error, not ignored flags.
- Preserve a matrix distinguishing source evidence, no-inference protocol checks,
  and live inference. The current source pin and installed version are separate
  facts; a source checkout is not proof of what an installed binary does.

Gate: if descriptor retention fails, choose and test a small dedicated guardian
adapter before implementing launch; do not ship a PID-only fallback.

## L1. Thin profiles, copying and executable provenance

Implement path resolution, small launcher-owned metadata, atomic creation,
inspection/listing and a CLI interview over the library. Keep native Codex config
native and preserve unknown keys. Use simple file/category copying and a round-trip
editor only where convenience edits are requested. Do not create a security scanner,
a full native schema or a shared `pdum` CLI framework.
Use Typer; export an app and factory that can be mounted by another application.

Acceptance:

- Names/alternate roots/explicit paths resolve predictably; conflicting selectors
  or ambiguous ownership paths fail without touching another profile.
- Concurrent creation yields one complete profile and one conflict; failed creation
  removes only its staging state.
- Whole native config copies verbatim when no edit is needed. Unknown fields,
  nested profiles, MCP environments, inline credential values/references and helpers
  survive requested copies without per-field consent or disabled integrations.
- Category exclusions and explicit-value precedence work. Tests include novel
  native keys, not only today's known schema. Preview lists paths/choices rather
  than dumping credential values.
- Source files are unchanged; sessions/locks/caches/captures are not cloned.
  Intentional external references are preserved with shared-resource warnings;
  dangling/cyclic copy paths fail rather than writing unexpectedly.
- Non-TTY commands never wait for a security confirmation. Missing required values
  fail clearly; no silent model substitution.
- Missing executable fails. Changed executable warns/records provenance by default;
  explicitly requested exact pins fail on mismatch. Overrides do not silently
  rewrite the saved selection. Record wrapper/artifact identity limitations.
- Exercise standalone and mounted Typer commands against the same library. Two
  app factories do not leak provider registration between hosts; import/mount does
  not launch processes, install signals or start an event loop.

These are ordinary filesystem/configuration tests, not simulated provider evidence.

## L2. Predictable environment and native upstream authentication

Implement clean/inherit environment selection, profile-local homes/work directories
and clear precedence for the few launcher-owned values. Provide isolated ChatGPT
login, API-key references and API-federation helper setup using native mechanisms.
Do not rewrite account messages originating from clients.

Acceptance:

- Deliberately polluted parent home/proxy/auth selectors cannot accidentally choose
  the wrong profile in clean mode. Explicit inheritance and copied helper inputs
  work without a secret allowlist; known missing inputs yield actionable errors.
- Fresh minimal state has no accidental normal-user integrations. Cloned state
  retains the copied integrations. Project/system layers remain possible and are
  described honestly, not treated as a failed security sandbox.
- New profiles default to native no-sandbox/no-approval settings. Explicit operator
  overrides work; incompatible managed policy is reported, never silently described
  as unrestricted. No permission rewriting is injected into RPCs.
- Login/launch agree on home/store and lease. Success means completed login, not
  just a URL. Cancellation is bounded; a real login uses a chosen dedicated profile.
- Credential references are consumed normally; routine status does not dump values.
  Child environment-key rotation requires restart; status alone does not prove
  upstream acceptance.
- Helper/provider conflicts, missing files and invalid lifetimes fail clearly.
  Do not introduce a new OAuth broker, native schema or comprehensive log redactor.

## L3. Async launch, lease, readiness and shutdown

Implement the state machine, inherited lease, atomic owner journal, private owner
control socket and continuous bounded drainers. CLI remains foreground; library
context manager owns cleanup without installing global signal handlers. Add native
Unix and tested native WS endpoint variants, status and explicit stop/recovery.
tmux/Docker can supervise the foreground command. No daemon, attach-to-existing
convenience or automatic restart is required; duplicate launch is a clear error.

Acceptance:

- Hundreds of racing launches of one profile produce at most one child. Path aliases
  share ownership. Different profiles can run independently.
- Race cancellation/crash at each boundary: lease acquired, sidecar preparation,
  spawn before journal update, endpoint bound before initialize, ready, shutdown.
  No false-ready result, leaked owned listener, or second successful launch occurs.
- Repeat the real parent-SIGKILL orphan test from L0 through public APIs. Test PID
  reuse, missing journals, unresponsive owner, stale socket and unverifiable
  process identity. Uncertainty blocks rather than kills or steals ownership.
- Verify parent cleanup closes its descriptor instead of unlocking the shared open
  file description. Inject late descriptor closure in the child; journal checks must
  block an overlapping owner and mark the binary combination unqualified.
- A short-lived readiness connection initializes and closes; subsequent clients
  initialize their own sessions normally. No readiness model call is made.
- Fill both subprocess output pipes while a child runs; prove the event loop and
  cancellation still progress. Bounded diagnostics report truncation explicitly.
- SIGTERM then bounded SIGKILL affects only verified owned groups; reap children,
  preserve original exceptions and surface incomplete cleanup. Test a child and a
  descendant that outlive the parent, including retained lease descriptors.
- Mutating auth/executable/profile operations fail while a managed run is live.
  Read-only status remains available. Raw client changes are not silently reverted.
- Status/JSON and busy errors expose server/owner PID, process birth identity,
  profile, endpoint and journal path plus the stop/recovery command. Cleanup works
  without guessing a PID or deleting a lock; reused PIDs are never blindly killed.

## L4. First-class temporary profiles

Implement clean and cloned temporary contexts, convenient auth copying, retained-temp
output and safe leftover inventory/prune. This is core functionality, not a late
security-reviewed escape hatch.

Acceptance:

- `--temp` uses fresh settings and available current file auth with one warning;
  `--from-profile` copies source settings/skills and available file auth by default.
  No consent prompt, per-field reference flag or special risk acknowledgment.
- `--clean` copies no source state and rejects conflicting source/borrow options.
  `--no-auth-copy` omits only the auth-file snapshot; document/test that native
  config can still contain auth. Explicit borrowing selects its named source.
- Histories, caches, locks, sessions and captures are excluded from settings clones.
  Unknown native config and credential references remain intact.
- Resolve current auth before changing the child environment. Copy, never symlink
  or write back. Warn about competing refresh owners without blocking the operation.
  Missing/keyring-only file sources get a direct next step, not account fallback.
- Use dummy auth files for copy tests; do not provoke live refresh races in the
  operator's normal account just to test them.
- Stop all owned processes before temporary deletion. Keep/failed cleanup reports
  the path. Prune refuses live/uncertain/replaced directories; test the lease/disposed
  marker race so cleanup cannot delete a profile another run just acquired.

## L5. Thin relay, asynchronous inspection and processor hooks

Implement one-to-one WebSocket forwarding with all-interface TCP defaults and
configurable binds. Use native Unix/loopback wiring as needed
to satisfy the selected binary's backend requirements without adding a client
authorization layer. Copy selected messages into independent async observer tasks
without waiting for parsing, disk or remote export. Local recording starts off.
Start with file/test processors and explicit selection; provider discovery and
namespaced Typer options can be added without making them required for launch.

Acceptance:

- A real browser uses ordinary `new WebSocket(endpoint)` and initializes without
  grants, token files or subprotocol authentication. Trusted browser origins and
  native clients work without a launcher Origin allowlist.
- Verify bind/address advertisement and an explicit loopback override. Exercise a
  trusted-network client; an all-interface bind is not an authorization boundary.
- Distinguish direct native requirements from relay frontend defaults. Backend
  authentication/Origin handling follows the binary; no false claim it was disabled.
- Two clients with overlapping RPC IDs retain separate sessions. Account/config
  requests, server requests, unknown methods and notifications pass unchanged.
- Connections survive more than 15 minutes and idle periods without an arbitrary
  expiry. Use deterministic timer tests plus a soak check; genuine peer failure,
  explicit shutdown and unavoidable native/transport failures remain valid close
  reasons. Recorder load/failure never deliberately closes healthy traffic.
- Test fragmentation, ping/pong, large messages, backpressure, disconnect and
  upstream death. No silent message drops or automatic replay.
- Enabled recording preserves unknown/account payloads, including dummy tokens.
  Optional masking affects only output and is labeled; it is not a release gate.
  Routine status avoids dumping payloads. No real captures enter public CI artifacts.
- Slow/failing observers do not gate forwarding or unrelated processors. Verify
  with a real peer and an async delayed sink, not only an archive assertion. Queue
  age/bytes, processor errors and actual losses are observable; no initial capture
  size, queue admission, decoder or run-volume caps are imposed.
- Large complete messages survive recording. No old 16 MiB relay ceiling or
  truncation-prefix default is silently carried forward; selected library/backend
  limitations are explicit and tested, not called unlimited transport support.
- File/test processors exercise explicit factory/object configuration and derived
  record attribution. Optional discovery lists providers without activating them;
  selected provider CLI contributions compose without name collisions.
- A small Codex-aware test processor can derive usage metrics without changing or
  querying the protocol. Repeated cumulative/end-of-turn totals are not double
  counted; unavailable fields stay unknown and cost estimates name their pricing
  basis. Concrete remote exporters remain separate optional adapters.

Do not implement grant/revoke APIs, credential handoff files or a dormant lockdown
authorization stack as prerequisites.

## L6. Integrate MITM without duplicating its engine

Add the optional package extra and Codex trust/environment adapter against the
[canonical MITM contract](../specs/mitm.md). Start sidecar first; stop Codex first.
Expose capture status and revisioned changes through the private owner control
socket. Keep relay recording distinct from upstream capture.

Acceptance:

- Launcher works without MITM installed. Explicit MITM use without the extra gives
  an actionable error before spawning Codex.
- Default launch has no sidecar/CA/proxy overlay. With a sidecar, recording-off
  still establishes the intercept path from the start; recording-on adds output.
  Verify toggling does not reconnect a healthy WSS flow or imply retroactive
  interception of a direct or tunnel-excluded connection.
- Readiness/env overlay, bypass of local endpoints, sidecar crash, capture sink
  degradation, flush timeout and partial startup follow the documented ownership
  rules. Never retry direct on a failed intercept connection.
- Use an inexpensive real `gpt-6-luna` turn with the entitled selected account and
  a bounded prompt. Verify observed upstream HTTP/WS traffic and model, not a claim
  based on model name. Record usage and a dated estimated cost, separate from billing.
- Toggle capture off/on/off during an existing live WebSocket connection and verify
  revision acknowledgments, partial-prefix markers and output boundaries with the
  MITM package's tests. Confirm no raw credentials are published as evidence.
- Prefer live probes for actual API behavior. Deterministic local failure fixtures
  remain useful for cancellation, corruption, overflow and transport faults. Stay
  around USD 0.05–0.10 per investigation, with up to USD 1 authorized for important
  validation; coordinate spend and use no expensive fallback.

### L6a. Optional async management adapter

If useful for the first application, expose the existing status/stop/capture
operations through a small optional FastAPI app/factory. Reuse the current runtime
owner and async library; request handlers must not block or start another
supervisor. Test delegated calls, errors, capture changes and that mounting the
adapter does not launch duplicate processes. CLI/library usage must work without
FastAPI installed. This is welcome follow-on scope, not a prerequisite or a daemon.

## L7. Qualify API-platform federation explicitly

Use a dedicated API service-account mapping and a trusted cloud-identity helper.
Document the helper input environment, absolute executable, identity acquisition,
API exchange, lifetime budget and retry policy. Do not implement native ChatGPT WIF
under the same mode name or silently reuse that environment contract.

Acceptance:

- Live identity acquisition and API exchange complete for the configured deployment;
  one tiny real inference proves the chosen endpoint/model/credential combination.
- Prove demand-driven refresh across actual token expiry/recovery. Keep raw local
  diagnostic captures out of published evidence; there is no requirement to mask
  every internal record. A dummy helper test alone does not qualify federation.
- HTTP/SSE qualifies first. Separately test authentication on a long-lived upstream
  WebSocket, renewal, reconnect and failed helper/expired identity. If unavailable,
  leave WS federation explicitly unsupported rather than promising transparent
  mid-connection credential replacement.
- No auth changes to ordinary developer Codex; failure is explicit and does not
  select another account, provider or model. Record account class without secrets.

Cloud credentials/admin mapping are an external prerequisite. If not available,
ship configuration support marked unqualified and report this gate as pending.

## L8. Package validation and follow-on boundary

Run focused tests, then full workspace lint/format/test, strict docs and distribution
builds on Python 3.12–3.14. Add macOS/Linux lifecycle jobs; do not conflate Ubuntu
unit success with macOS orphan recovery. Keep live-cost/auth jobs opt-in and ensure
CI artifacts contain only redacted summaries, never profiles or captures.

Publish examples only after their interfaces work: persistent login/launch, temp
borrow, clone-without-auth, browser relay, capture toggle, and explicit API helper.
Record unsupported combinations and exact binary test matrix. No fabricated green
tests; no automatic commit, tag or package publish.

Deferred work requires separate design: lockdown mode,
cloud snapshot/restore and thread-store replacement, detached daemon
mode, Windows/distributed leases, credential brokers and automatic custom-binary
distribution. FastAPI management and small Logfire/Grafana-compatible adapters are
optional follow-ons over existing hooks, not a service/plugin framework required
for the first local candidate. The composable CLI/control socket leaves room for
later hosts without implementing daemon or migration machinery now.
