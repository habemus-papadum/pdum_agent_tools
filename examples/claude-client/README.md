# Official Claude SDK clients

These private examples provide a small browser conversation workflow and qualify
the published TypeScript SDK against the Python launcher. They are not Python
package runtime dependencies. Node 22+ is required to build or use the Node example.
The browser example needs a normal browser with WebSocket support.

```sh
cd examples/claude-client
pnpm install --frozen-lockfile
pnpm build
```

Serve `dist/` from the launcher's management app, with API requests on the same
origin. The Python API's `example_directory` option or the CLI's `--example-dir`
option mounts this directory at `/example/`. For example, from the repository root:

```sh
uv run --frozen pdum-claude launch --all-profiles --example-dir examples/claude-client/dist
```

Open the printed management address at `/example/`. The page lists profiles already
configured on that manager; authentication and profile creation stay on the host.

## Browser workflow

1. Choose a profile. Its model and workspace are shown below the selector.
2. Read a saved conversation, or choose **New conversation**. Reading saved history
   makes no model request and starts no worker. New opens a worker and initializes
   the official SDK; inference begins only when you send a message.
3. Use **Resume** to open the selected history in a new worker, or **Fork and continue**
   to create a separate saved conversation and open that fork. Neither action copies
   the workspace or sends a prompt automatically.
4. Send messages, read streamed text and expandable tool input/results, or interrupt
   the current turn. Cmd/Ctrl+Enter sends. The displayed usage estimate is the SDK's
   cumulative conversation estimate, including earlier turns on resume.
5. Choose **End session** before changing profile or conversation. Closing the tab
   also closes the SDK and requests worker cleanup. A lost connection is displayed;
   the page never reconnects or resubmits prompts automatically. Saved history can
   be resumed explicitly.

One tab manages one live worker. Separate tabs can use the same profile independently.
The ordinary chat sends no turn, token, or budget limit and inherits the manager's
launch defaults. There are no provider credentials in browser requests or storage.
The SDK owns its query, prompt stream, hooks, callbacks, interrupt and close. Profile
selection, history, fork/rename and worker lifecycle use the separate management API.

This is a small example, not a full Claude UI. It displays text and tool details,
with images represented by a placeholder. A native tool-permission request has
**Allow once** and **Deny** controls; launcher defaults still disable permission
prompts. AskUserQuestion, unsupported native dialogs and MCP elicitation forms are
cancelled with an activity entry; the operator can answer questions in chat instead.
Rich tool interactions, image/file attachments and dialog forms
are not implemented. Actual Chrome checks passed a live API-key turn, history
selection, rename, resume/fork initialization, profile switching and tab-close
cleanup. The four-turn browser probe passed concurrency and fork/resume recall.
Permission controls and mid-turn UI interruption still need live qualification;
SDK interrupt control and client-owned prompt hooks passed. See the
[qualification report](../../docs/claude-validation.md) for versions and costs.
The [checkpoint and follow-up](../../docs/claude-handoff.md) records the remaining
work when development resumes.

## Compatibility checks

Expand **Compatibility checks** while no chat worker is active. **Check connection**
initializes the SDK and exercises controls without a provider request. **Run paid
check** explicitly runs one bounded turn; use a Haiku profile. The existing browser
automation API below remains available.

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
