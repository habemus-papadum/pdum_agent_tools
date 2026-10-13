# Official Claude SDK clients

These private examples qualify the published TypeScript SDK against the Python
launcher. They are not Python package runtime dependencies. Node 22+ is required.
The browser example needs a normal browser with WebSocket support.

```sh
cd examples/claude-client
pnpm install --frozen-lockfile
pnpm build
```

Serve `dist/` from the launcher's management app, with API requests on the same
origin. The Python API's `example_directory` option or the CLI's `--example-dir`
option mounts this directory at `/example/`. Open `/example/`, enter a configured
profile name, and choose the initialization check. It makes no provider request.
The second button explicitly runs one paid turn; use a Haiku profile.

For the official Node entry point:

```sh
node node.mjs http://127.0.0.1:8080 default
node node.mjs http://127.0.0.1:8080 default --live
```

`--resume SESSION_ID` starts a new worker using saved history. The browser also
exposes `window.pdumClaudeProbe.run({profileId, live, resume})` for qualification.
Both paths initialize the SDK, send an interrupt control request and close the
connection. Live mode additionally checks a client-owned hook callback, a model
result and saved history through the management API. The manager reports the
worker's final stopped state. Reports include SDK usage and reported cost; those
are estimates, not a statement of subscription billing.

For the four-turn browser qualification, use
`window.pdumClaudeProbe.runFull({profileId: "a", otherProfileId: "b", live: true})`
with two isolated profiles. It runs two simultaneous same-profile conversations,
checks disconnect independence, renames and forks saved history through the
Python SDK, and verifies marker recall in both a fork and an explicit resume.
Each worker has its own $0.05 SDK budget. The report retains individual usage;
cumulative conversation costs must not be summed as incremental spending.

The same full flow can run through the official Node root SDK:

```sh
node node.mjs http://127.0.0.1:8080 a --full --live --other-profile b
```

`--full` requires `--live`; it never enables inference implicitly. The second
profile is used for history-isolation checks, while all four paid turns use the
first profile. Use fresh profiles with the same workspace to exercise this gate.
Failed probes exit nonzero and retain available result usage in their JSON report.

The browser uses the SDK's WebSocket transport directly. Its pinned browser build
currently needs a small `process` compatibility object, installed by the example
bundler. The Node root SDK uses its public `spawnClaudeCodeProcess` callback with
`node-transport.mjs`: this adapts byte streams and lifecycle to a WebSocket without
parsing the protocol. The manager owns process launch options. Do not expect local
Node SDK spawn arguments to configure a remote worker; put those options in the
management request instead.

The browser client has no provider credentials. The Python manager resolves
authentication on the host. Closing either SDK client ends its worker; resume
starts a new one. History is a separate management API backed by the official
Python SDK.

The probes request `tools: []`, `max_turns: 1`, and `max_budget_usd: 0.05`. These
are explicit experiment settings, not limits on ordinary launcher sessions.
SDK version changes require repeating the interoperability checks.
