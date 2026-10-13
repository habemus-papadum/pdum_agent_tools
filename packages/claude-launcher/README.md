# habemus-papadum-claude-launcher

Import: `pdum.claude_launcher`. CLI: `pdum-claude`.

Isolated Claude profiles, foreground process ownership, and a thin relay for
official browser and Node Agent SDK clients. A profile supports several workers;
disconnecting a client ends its worker. Saved conversations remain available
through the official SDK's history helpers.

The first implementation is available in this workspace and has not been published.
Official Node SDK control, callbacks, a live Haiku turn, saved-history reads and
optional MITM capture passed. Dedicated native login and a subsequent live turn
also passed. Genuine API-key inference and actual-browser qualification remain open. See the
[guide](https://habemus-papadum.github.io/pdum_agent_tools/claude/),
[architecture](https://habemus-papadum.github.io/pdum_agent_tools/specs/claude-launcher/)
and [qualification report](https://habemus-papadum.github.io/pdum_agent_tools/claude-validation/).

```sh
uv run pdum-claude profile create research --workspace /path/to/project --auth native
uv run pdum-claude --profile research auth login
uv run pdum-claude --profile research launch
```

Authentication supports an API key referenced by environment variable, native
Claude-account login, and explicit existing-login access-token reuse. Profiles
preserve native settings; settings-source selection controls user/project config.
Concurrent workers share profile authentication but each has its own client SDK
query and process. Token refresh for borrowed credentials is not managed.

`--temp` creates a disposable profile, with warning-based login reuse by default.
`--all-profiles` registers all named profiles. Client disconnect, explicit stop and
foreground shutdown end owned workers; saved history remains in persistent profiles.
The CLI uses trusted-network defaults: all-interface listeners, sandbox/approval
prompts off, no mandatory client grants or arbitrary idle expiry.

The Python API exports `ClaudeManager`, `LaunchOptions`, `History`, `open_relay`,
profiles and authentication operations. `cli.create_app()` is a mountable Typer
factory; importing it starts nothing. The `management` extra supplies an optional
FastAPI/Uvicorn adapter over the same process owner. The `mitm` extra composes
the independent `pdum.mitm` sidecar; no Codex dependency is introduced.

`--record NEW_FILE` enables complete asynchronous protocol recording. `--mitm`
adds scoped upstream interception; `--capture` enables its recorder. Inspection
reports backlog, storage and actual failures. Public SDK cost estimates remain
separate from subscription billing; missing result usage is unknown.

The official browser and Node client examples live in `examples/claude-client/`.
Node uses the SDK's public spawn-transport adapter; the browser uses its WebSocket
entry. They are compatibility examples rather than a complete chat application.
