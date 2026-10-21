# Design principles: trusted operation, practical hygiene

**Maintainer decision:** the operating stance on this page is agreed. Package APIs
and implementation details remain proposals. This page supersedes the defensive
defaults in earlier architecture drafts; do not reintroduce them during routine
implementation or review without discussing a change of requirements.

## Who this is for

One advanced operator controls the network and has substantial trust in the agents,
applications, and plugins running inside it. Separation from untrusted actors is
provided at the **network boundary**, outside these packages. The default product
is not a multi-tenant service and does not try to protect the operator from their
own agent or other trusted clients on that network.

Network membership therefore grants substantial access. The operator must arrange
the intended network boundary; these packages do not establish one. Binding all
interfaces can also expose a listener on an unintended network if the machine is
connected to one. Make the effective endpoints visible, without recurring prompts
or an application authorization system on the default path.

## Agreed defaults

| Concern | Default stance |
| --- | --- |
| Agent execution | Sandbox off; approval prompts off. Translate to the selected Codex binary's native settings and report actual behavior. |
| TCP listeners | All host interfaces (`0.0.0.0` for IPv4; explicit `::`/dual-stack support where tested), with configurable bind addresses. |
| Client access | Trusted-network access; no launcher-issued capability, login ceremony, Origin allowlist, or mandatory application TLS layer. |
| Long-running connections | No arbitrary authorization/idle expiry and no forced reconnect after 15 minutes. Shutdown, failures and genuine transport limits still apply. |
| Profiles | A profile directory is a Codex home with launcher metadata in `.pdum/`; the user's own home is the `--default` profile. Native Codex configuration stays native, and launch passes choices as `-c` overrides instead of editing it. |
| Temporary work | Clean or cloned temporary profiles are first-class. Cloning and credential reuse should be quick, predictable, and warning-based rather than permission-gated. |
| Process lifetime | Provider launchers retain foreground/application-owned library lifetimes. The accepted unified host coordinator may run foreground or later as one optional daemon; separate provider daemons and seamless crash survival are not implied. Attaching to a foreign server remains an explicit testing affordance. |
| Profile ownership | Codex coordinates concurrent processes in one home natively, so the launcher records each run it starts and inspects homes rather than holding an exclusive lease. Claude permits multiple independent workers per profile. Record owned PIDs and process identity; make status and verified stop/cleanup straightforward. |
| MITM | No sidecar by default. Explicit interception starts with the consumer; recording can start off and be toggled later without replacing its connection. |
| Captures | Recording is off until enabled. Then preserve complete observed application payloads without initial size caps, truncation thresholds or run quotas. Redaction is optional. |
| Observation | Copy messages into a separate asynchronous inspection path. Recording, parsing and export must not gate or mutate forwarding. Report observer failures rather than stopping healthy traffic. |
| Plugins and sinks | Explicitly selected processors, with simple local/test implementations first. Discovery is a CLI convenience, not a prerequisite or automatic activation. |
| CLI composition | Both packages use Typer and export mountable apps/app factories; commands delegate to the async libraries. |

These are application design defaults, not a promise that every Codex binary or
managed host policy permits them. Report incompatible native requirements rather
than claiming they are disabled. A backend Unix socket or loopback connection may
still be useful internal wiring; it is not a reason to restrict the client-facing
network listener. Normal upstream HTTPS verification remains useful for connecting
to the intended service and is separate from application access control.

## Keep hygiene, not a security framework

Retain safeguards that prevent accidents and make experiments reproducible:

- Resolve the requested profile unambiguously. Avoid accidental state sharing,
  source-profile writes and output overwrites. Several app-servers may share one
  Codex home, as Codex itself supports; disposal refuses while anything uses it.
- Give each run identifiable paths and lifecycle ownership. Recover stale state
  without killing an unrelated process or deleting a directory someone still uses.
- Keep environment/proxy/CA changes scoped to the launched process. Do not silently
  alter the operator's ordinary Codex setup or global machine configuration.
- Keep startup, control operations and shutdown time-bounded. Monitor capture
  bytes, backlog, lag, memory and failures instead of imposing initial payload,
  decoder, queue-admission or disk quotas. Do not quietly reinstate capture caps
  as hygiene. Resource guardrails can be designed later from actual workloads.
- Report real loss, missing prefixes, engine limitations and incomplete cleanup.
  No fixed capture quota does not mean infinite resources or guaranteed delivery:
  disk exhaustion, process crashes and memory pressure remain observable failures.
- Use inexpensive file-permission defaults where convenient. Avoid dumping entire
  credentials or environments into routine status messages, but do not build a
  generalized secret detector or treat raw diagnostic captures as forbidden.

Local or operator-configured capture sinks may contain tokens, prompts and other
sensitive content. Selecting such a destination is sufficient; no second export
approval or per-field consent system is required. Simple masking can be offered
when useful, without dropping unknown data or blocking the main workflow.

**Public publication is different from trusted runtime use.** Do not commit
credentials, profiles, raw captures, CA private keys, or credential-bearing CI
artifacts. Review/redact shared summaries at the publication boundary. This does
not require redacting every runtime record or forbidding intentional internal logs.

## Stay thin around Codex

Treat native config as an opaque file or ordinary TOML mapping. Preserve unknown
fields and native credential/helper references during requested copies. Use a
small set of convenience edits for commonly requested options, not a second model
of Codex's entire configuration or a per-version secret-field classification tree.

The Python API accepts a profile directory; CLI names are a convenience layer.
Copy by categories/files with an ordinary preview and warnings about shared paths
or rotating credentials. Do not turn a quick clone into a security interview.
Native authentication and RPC behavior remain Codex's responsibility.

## Inspection hooks, not another agent framework

The client relay is a browser-compatibility adapter and an inspection tap. Copy
messages with direction, sequence and run/connection identity to an asynchronous
observer path; forward the originals unchanged without awaiting processing or
export. Keep upstream MITM observations distinct from client protocol observations.
Processors may write records, derive metrics or publish to configured services.
Token/cache usage and cost interpretation belong to Codex-aware integrations in
the launcher or an adjacent package, never the generic MITM core. Missing metrics
stay unknown; inferred costs need explicit pricing provenance.

Provide explicit processor selection through the API/launch configuration first.
Small filesystem and test processors exercise the hooks. Optional entry-point
discovery can list installed providers and let selected providers contribute CLI
options or subcommands. Do not require a worker process per plugin or a remote
logging framework. Logfire/Grafana-compatible exporters can be small optional
adapters later; their actual size depends on the chosen integration.

An optional async FastAPI management adapter is welcome, but must reuse existing
status/stop/capture operations and never become a second process owner. It is not
required for the first local slice.

**19 October 2026 direction:** the [unified host coordinator](plans/agent-orchestrator/components/21-host-coordinator.md)
can compose the libraries and expose discovery/profile/launch/status services to
a TypeScript management client. Start foreground; optional daemon hosting and
partner-host management are accepted directions for later implementation. This
extends the earlier no-daemon scope at the coordinating layer without changing
the existing provider libraries' current ownership contracts.

The [pragmatic recovery sketch](plans/agent-orchestrator/failure-recovery.md)
separates rediscovery, client rejoin and reconstruction from history. Seamless
continuation is desirable where it earns its complexity, not a prerequisite.
Execution and some information may be lost; an operator or authorized recovery
agent may inspect what remains and relaunch. Report uncertainty and lineage,
avoid blind action replay, and leave exact automation/loss policies for preferences
and measured failure spikes. No new mandatory confirmation system is implied.

## Lockdown is a later, separate mode

A future **lockdown mode** may introduce restrictive binds, authentication,
Origin policy, sandbox/approval settings, redaction, and stricter export/import
rules. Its exact contract needs a separate design. It is not implemented, not a
first-release prerequisite, and not a reason to build dormant enforcement machinery
throughout the trusted default path. Existing simple configuration switches may be
used deliberately without claiming that a complete lockdown mode exists.

## Explicit intent and staged decisions

For orchestrator and client/UI development, use the
[working method](plans/agent-orchestrator/methodology.md): decide which questions
matter before each slice, ask when unresolved behavior becomes a real dependency,
and leave later questions open. Mocks can explore alternatives without silently
establishing defaults. Routine delegated engineering choices remain the agent's
responsibility; important lifetime recommendations are discussed when needed.

Make intent explicit before reducing friction through inference. A prompt that
steers the current turn, a queued next turn and an interruption/replacement are
different user choices. Show meaningful target/timing/effect and the observed
outcome. Later inferred choices must remain visible and overridable, with an
inspectable reason; do not describe an inferred choice as an explicit request.
This is interface semantics, not an additional approval/grant system.

The [provisional visual direction](plans/agent-orchestrator/visual-direction.md)
records personal UI preferences: dense controls, expressive color and CSS
experiments grounded in Habemus Papadum's design system. Review the experiments
and consider useful patterns for upstream reuse; do not freeze a mock into a
global design rule.

## Test reality, not simulated provider success

Implementation is authorized. Prefer real local processes, HTTP/TLS/WebSocket
peers and installed Codex interoperability checks. Use fixtures for deterministic
parsing and fault injection, not as substitutes for successful live API behavior.
For provider checks use `gpt-6-luna`, normally targeting USD 0.05–0.10; important
investigations may spend up to USD 1. Coordinate aggregate work across agents,
bound turns/time/retries and report usage plus dated cost estimates rather than
claiming subscription billing is known. Do not silently select a different model.

The first end-to-end milestone is a vanilla Codex CLI in remote-client mode using
our relay as if it were the native app-server endpoint, including a short live
turn. This is an integration test, not a mocked protocol unit test. Determine the
supported client invocation from the actual binary; do not assume `codex exec`
supports the same remote mode as the terminal UI. Paid tests are explicitly opt-in
and never part of ordinary pull-request CI.
