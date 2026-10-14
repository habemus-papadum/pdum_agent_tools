# Claude profile isolation qualification

**2026-10-13.** Separate Claude configuration directories provide the isolation
needed by the launcher: each profile sees its own user agents, commands, skills,
instructions, installed plugins and MCP configuration. Two profiles using the same
workspace deliberately see that workspace's selected project configuration. No
launcher source change was needed for these checks.

These results concern the Python launcher and its official Node SDK client. They
do not claim a filesystem sandbox or isolation from machine-managed policy.

## What passed

Three integration tests created disposable profiles A and B, one shared workspace,
and a synthetic ordinary home directory. That home contained a different set of
user agents, commands, skills, `CLAUDE.md` and rules. Both native workers inherited
the same home while the launcher selected distinct `CLAUDE_CONFIG_DIR` values.
The ordinary-home fixtures remained byte-for-byte unchanged and did not appear in
either profile's discovery results.

| Configuration | Observed result |
| --- | --- |
| User agents, legacy commands and skills | Each profile discovered its own fixtures and excluded the other profile's fixtures. |
| Project agents, commands and skills | Both profiles discovered the shared workspace fixtures when `project` was selected. |
| User and project settings | The shared project `outputStyle` overrode the two different user values. User-only launches retained their own value. |
| Project-local settings | `.claude/settings.local.json` applied only when `local` was included. The default `user,project` selection excluded it. |
| Instructions and rules | The public SDK context summary reported the selected profile's `CLAUDE.md` and rules, plus selected project instructions and rules. `CLAUDE.local.md` required `local`. |
| User MCP servers | Servers added with native `claude mcp add-json --scope user` connected in their own profiles only. |
| Project MCP server | The shared workspace `.mcp.json` server connected in both profiles. |
| Installed plugins | Native installation from a disposable local marketplace, native plugin listing, and SDK discovery agreed that each profile had only its own installed plugin. |
| Plugin components | Each installed plugin's agent, legacy command, skill and MCP server appeared only in that profile. Excluding `user` excluded the user-installed plugin. |
| Cleanup | All 14 native workers and all eight fixture MCP processes exited after their clients disconnected. No cleanup errors were reported. |

The source-selection matrix used one profile and fresh independent workers:

| `setting_sources` | User customizations/instructions | Project customizations/instructions | Local override/instructions |
| --- | --- | --- | --- |
| `user,project` — launcher default | Included | Included | Excluded |
| `user` | Included | Excluded | Excluded |
| `project` | Excluded | Included | Excluded |
| empty | Excluded | Excluded | Excluded |
| `user,project,local` | Included | Included | Included |

User-only, project-only and empty selections also selected the corresponding MCP
servers. In the tested fixture, an empty selection returned no configured MCP
servers. It still had native built-in commands and agents; empty settings sources
are not a request to remove native features.

## How this was checked

The tests used public native configuration commands and the official Node SDK's
`initializationResult()`, `supportedAgents()`, `supportedCommands()`,
`mcpServerStatus()`, `getContextUsage({detail: "summary"})` and `interrupt()`.
The SDK connected through the example's public `SpawnedProcess` adapter to the
Python manager and byte relay. The context summary uses local estimates; the
default full context calculation, which can call the token-count API, was not used.

The MCP fixture was a real local stdio subprocess implementing initialization and
an empty tool list. Tests verified its successful native connection and shutdown,
and verified that no `tools/call` request occurred. Plugins came from local fixture
files registered and installed through the native CLI. No private plugin registry,
MCP state or native recovery format was parsed or manufactured.

The test records checked that the client sent no user prompt, that initialization
reported no authentication token, and that the SDK emitted no assistant or result
messages. **Model requests: 0; estimated model usage cost: USD 0.** No provider
billing was inspected, and orchestration-agent costs are outside this ledger.

Versions: native Claude Code **2.1.296**, official TypeScript SDK **0.3.296**,
Node **26.10.0**, Python **3.14.7**, macOS arm64. The final focused run returned
**3 passed in 3.79 seconds**. Ruff lint and formatting checks passed for the test.

Reproduce from the repository root after installing the example dependencies with
`pnpm install --frozen-lockfile` in `examples/claude-client/`:

```sh
uv run --frozen pytest packages/claude-launcher/tests/test_profiles_native.py -q
```

The tests carry the `claude` marker and visibly skip if the native `claude`
executable, Node, or the example's installed official SDK is absent. They do not
require the optional management HTTP server or provider credentials.

## Meaning for the product

A profile is a native user-configuration and authentication location. It does not
need to correspond to one client: concurrent workers can use the same profile and
discover the same configuration. Independent projects should use different
workspaces when their project customizations need to differ. A user who wants a
profile's own customizations without the workspace additions can select `user`.

Configuration remains native. Claude documents `CLAUDE_CONFIG_DIR` as selecting
the settings, history and plugin directory; this launcher supplies that value
instead of implementing another customization registry.
[Claude environment variables](https://code.claude.com/docs/en/env-vars).

The default exclusion of `local` is visible behavior worth showing in profile
setup: selecting the same workspace as a developer's interactive CLI does not
automatically include that workspace's personal override file. Claude's documented
precedence applies among the sources that are enabled.
[Settings files and precedence](https://code.claude.com/docs/en/settings).

The selected project can intentionally contribute executable hooks, plugins and
MCP servers. This qualification exercised configuration discovery and local MCP
connections, not arbitrary third-party component behavior. MCP source selection
and native approval behavior remain Claude's responsibility.
[MCP configuration scopes](https://code.claude.com/docs/en/mcp).

Managed settings, organization policy, account-synced customizations, environment
variables, filesystem access and external services can still affect multiple
profiles. The tests did not modify or qualify managed policy. In particular,
profile directories are not a way to bypass machine or organization configuration.
Claude documents that managed settings apply across local sessions.
[Managed settings](https://code.claude.com/docs/en/settings#check-what-your-organization-enforces).

Remaining limits are semantic instruction-following during inference; authenticated
skill/plugin syncing; plugin updates and reloads; external MCP OAuth and tools;
Git worktree/subdirectory discovery; and managed configuration. The tests also do
not qualify concurrent writes to the same plugin/configuration files or native
credential refresh. Those are distinct from the verified case of concurrent
workers reading an already configured profile.

See the broader [qualification report](claude-validation.md) and
[operator guide](claude.md) for authentication, saved history and client lifetimes.
