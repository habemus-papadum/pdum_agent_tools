# Claude launcher

**Agreed direction, 2026-10-13:** a Python library and mountable Typer CLI manage
isolated Claude profiles and foreground native workers. Browser and Node clients
use the official TypeScript Agent SDK for live conversations. Python live clients
are outside the supported scope. Implementation status and evidence belong in
the [delivery plan](../plans/claude-launcher.md) and [operator guide](../claude.md).

## Ownership and interfaces

The manager allocates worker identities and starts an unmodified Claude process
when a client attaches. The client SDK owns initialization, streaming, hooks,
control requests and callback answers. A raw WebSocket/stdio relay forwards the
protocol. No second SDK query lives on the host and no replacement conversation
API is introduced.

A separate management API exposes configured profiles, active workers and saved
conversations. Native storage is accessed through official Python SDK helpers in
a process whose profile environment is fixed. Never switch the manager's global
environment between requests or implement a private transcript parser. The async
library owns lifecycle; HTTP and CLI adapters call that same library.

Keep profile, workspace, saved conversation, worker and client connection identities
distinct. Multiple workers may share a profile and its authentication. They normally
write separate conversations. An explicit resume creates a new worker with saved
context; a fork creates a new conversation, not a workspace copy. Concurrent writers
to one conversation are not an established compatibility guarantee. The initial
relay has one official SDK controller per worker; additional viewers and coordinated
shared control can be designed later without making profiles exclusive.

## Profiles and authentication

Profiles contain a native Claude configuration directory and small launcher-owned
metadata for paths, executable, model, setting sources and authentication references.
Keep unknown native settings intact. A profile does not isolate project files or
host-enforced policy. Selecting project settings deliberately shares that project's
configuration; selecting user settings alone requests profile-only user configuration.
Resolve paths, avoid ordinary developer-state writes and make temporary profiles
convenient. Profile inspection must not print credentials.

The first authentication methods are:

- An API key resolved from a named host environment variable.
- Explicit reuse of an existing login's access token, with no promise of refresh.
- Native Claude-account login in the dedicated profile environment. Qualify this
  early, including macOS Keychain association, with human browser interaction when
  needed. A fresh profile must not silently reuse the ordinary login.

Provider and authentication selection remain distinct concerns. Bedrock, federation
and other provider identity flows are later adapters. Browser clients receive
connection information, never model credentials. Native renewal remains native;
cross-process renewal behavior and borrowed-token refresh are separate validation
work. Console login needs separate qualification because its credential store differs
from Claude-account login.

## Lifetime and defaults

Client transport closure stops its owned worker. WebSocket ping/pong detects silent
transport loss; there is no arbitrary authorization or idle expiry. Explicit stop,
normal manager shutdown and cancellation use the same bounded cleanup path. Never
signal unrelated PIDs. Lazy allocation avoids a live process for a never-attached
client. Saved history persists after worker exit.

There is no automatic callback recovery, replay, daemon, attach-to-existing native
worker or durable registry. Report uncertain cleanup and lost in-flight work honestly.
Abrupt host/manager death and arbitrary detached descendants need deployment-specific
qualification; normal child exit is not proof of all descendant cleanup.

Follow the [trusted-operation defaults](../design-principles.md): all-interface
listeners, sandbox and approval prompts off where the selected native executable
permits, no mandatory client grants, and no inference quotas unless explicitly
requested. Native launch options supported by this adapter are documented and
tested; accepting every SDK spawn option is not promised.

## Observation and composition

Client-protocol observation copies bytes into independent asynchronous processor
queues. Parsing, recording and exports do not gate forwarding. Record complete
observed data without payload caps and report backlog, storage, failed writes and
actual loss. Recording starts off. Public SDK usage/cost fields are estimates;
deduplicate cumulative totals and leave missing data unknown. Raw captures stay
out of Git and public CI artifacts.

MITM is optional and uses `pdum.mitm`'s public sidecar interface with process-scoped
proxy and CA configuration. Claude interpretation belongs here, never in MITM.
Hostfork may compose the launcher later; no package depends on Hostfork or the
Codex launcher merely to share supervision code.

## Compatibility gates

Pin and record the official SDK and Claude versions used for qualification. Retain
real browser and Node SDK initialization, callbacks, streaming, disconnect, concurrent
same-profile workers and saved-context resume/fork as upgrade checks. A small bounded
Haiku probe records usage and dated cost estimates separately from subscription
billing. Python's history helper support must be tested against isolated profiles;
TypeScript spike success is not evidence for a new Python implementation.

Native terminal attachment and desktop/phone Remote Control are optional investigations.
Do not implement private native internals to make them appear supported. The preceding
research is linked from [research and spikes](../research.md).
