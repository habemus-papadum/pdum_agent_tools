# 001 supporting notes — launch and control surface

These notes describe the installed `@anthropic-ai/claude-agent-sdk@0.3.296`, inspected and exercised on 2026-10-12. They support the [one-page result](001-claude-sdk-launch.md). Source statements below come from the installed npm distribution, not a rebuild of Anthropic's CLI.

## How the local launch works

1. `query()` constructs its transport immediately. `startup()` can also initialize a process before any user prompt. A string prompt represents a single input turn; an async iterable supports further inputs.
2. If `pathToClaudeCodeExecutable` is absent, the SDK resolves an OS/architecture optional dependency relative to its own installed module. On this machine that is `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`. Linux's resolver also distinguishes glibc/musl and has alternate-package fallback; those branches were inspected, not exercised.
3. If that package cannot be resolved, the TypeScript SDK throws an error asking for the optional dependency or an explicit path. The inspected default branch does not search `PATH` for a separately installed `claude`.
4. Paths ending in `.js`, `.mjs`, `.tsx`, `.ts`, or `.jsx` are treated as scripts. The SDK uses the selected `executable` (`node`, `bun`, or `deno`) with `[...executableArgs, scriptPath, ...cliArgs]`. Its default runtime choice is Bun when running in Bun, otherwise `node`. This script path is source-inspected only; the installed default is native.
5. Other executable paths are launched directly, with `[...executableArgs, ...cliArgs]`. Thus `executableArgs` is prepended to native CLI arguments too, despite its runtime-oriented name. Setting `executable: 'node'` does not force the bundled native binary through Node.
6. The built-in path calls Node `child_process.spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], signal, windowsHide: true})`. It does not use a shell or terminal. `spawnClaudeCodeProcess` replaces that call and receives the same launch description; a custom spawner owns stderr handling and any VM/container execution.
7. The host and CLI exchange newline-delimited JSON over stdin/stdout. The model API connection belongs to the child, not the TypeScript transport. Closing ends stdin first, gives approximately two seconds for cleanup, and then forwards cancellation; a custom spawner should honor the provided signal.

The hook was exercised by forwarding its arguments to a real Node spawn. Both default selection and explicit path ran the workspace binary. The probe captures the child streams while returning the expected `SpawnedProcess` interface. Unlike the built-in transport, the custom spawner does not implement the additional stderr-drain grace before reporting exit; that distinction does not affect these successful handshakes.

## Exact observed argument vector

For the `bundled-isolated` case, the command is the absolute platform-package `claude` binary. Its arguments are exactly:

```json
[
  "--output-format", "stream-json", "--verbose",
  "--input-format", "stream-json",
  "--max-turns=1", "--max-budget-usd=0.01",
  "--tools=", "--setting-sources=", "--strict-mcp-config",
  "--permission-mode=dontAsk", "--no-session-persistence",
  "--disable-slash-commands"
]
```

The first five entries are the transport's base arguments. The remaining entries reflect our supplied options, not SDK defaults. There is no explicit `--print` flag in this launch. Native Claude Code nevertheless enters the SDK protocol successfully. `extraArgs: { 'disable-slash-commands': null }` supplies the final boolean flag.

The `systemPrompt` is absent from argv. It appears in the first stdin control frame:

```json
{
  "request_id": "<generated>",
  "type": "control_request",
  "request": {
    "subtype": "initialize",
    "systemPrompt": ["This is an initialization-only probe. No user turn will be sent."]
  }
}
```

User prompts are subsequent `type: 'user'` frames. Hook callback identifiers, custom agent definitions, SDK MCP registration, and other host capabilities can also be supplied in initialization. Capturing argv alone therefore cannot reproduce a session. Level 0 should include launch configuration **and** initialization/input protocol; Level 1 is the public SDK message stream; Level 2 is the upstream model/API exchange.

## Launch options mapped to CLI and protocol

This table maps the inspected transport implementation. Unless called out in the main result, these options were not individually exercised.

| SDK option | Transport behavior |
| --- | --- |
| `cwd`, `env`, `pathToClaudeCodeExecutable`, `executable`, `executableArgs`, `spawnClaudeCodeProcess` | Process setup, not model instructions |
| `thinking` | Adaptive/disabled thinking or thinking budget; optional display flag |
| `effort`, `maxTurns`, `maxBudgetUsd`, `taskBudget` | `--effort`, `--max-turns`, `--max-budget-usd`, `--task-budget` |
| `model`, `agent`, `betas`, `fallbackModel` | Corresponding CLI switches; matching primary/fallback model rejected |
| `outputFormat` | JSON schema serialized to `--json-schema` |
| `debug`, `debugFile` | `--debug` or `--debug-file`; default spawner may add SDK diagnostic file |
| `canUseTool`, `permissionPromptToolName` | Host callback becomes `--permission-prompt-tool=stdio`; mutually exclusive with named prompt tool |
| `permissionPrompts`, `permissionMode`, `allowDangerouslySkipPermissions` | Explicit permission/prompt controls |
| `allowedTools`, `disallowedTools`, `tools`, `skills` | Tool switches; skill names become allowed `Skill(name)` entries |
| `mcpServers`, `strictMcpConfig` | External server config in `--mcp-config`; SDK in-process servers registered through initialize |
| `settingSources`, `settings`, `managedSettings`, `sandbox` | Source selection, explicit JSON/path settings, policy tier; sandbox merges into settings JSON |
| `continue`, `resume`, `forkSession`, `resumeSessionAt`, `resumeDropsTurn`, `sessionId`, `persistSession` | Session lifecycle switches including `--no-session-persistence` |
| `additionalDirectories`, `projectConfigRoot` | Repeated `--add-dir`; separately trusted project-config location |
| `plugins`, `pluginDelivery` | Local plugin directories via argv, or deferred initialize delivery |
| `includePartialMessages`, `includeHookEvents`, `sessionMirror` | Additional stream events/mirroring switches |
| `systemPrompt`, `agents`, `hooks`, host callbacks | Initialization payload / callback protocol |
| `extraArgs` | Arbitrary flag names; null produces `--flag`; strings usually become `--flag`, `value` |

Most typed options use `--flag=value`, which preserves values beginning with a dash. `extraArgs` uses two arguments except when the value starts with `-`, when it uses the equals form. It is appended late and can conflict with typed options. It exposes the CLI parser; it does not guarantee that every interactive feature has a useful SDK equivalent. The captured `cli-help.txt` records the installed binary's public CLI surface.

## Environment and configuration

At query construction, omitted `env` copies `process.env`; an explicit object replaces it. The SDK then injects `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION=0.3.296`, and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` unless already supplied. Optional features add more variables, including file checkpointing. Active OpenTelemetry trace context can inject `TRACEPARENT`/`TRACESTATE`. The transport removes `NODE_OPTIONS`, and removes `DEBUG` unless `DEBUG_CLAUDE_AGENT_SDK` enables it. Both removals were asserted using synthetic values in our input environment.

Our config root is separate from `~/.claude`; the work directory is outside the repository. The child gets no authentication variables. `settingSources: []` excludes ordinary user, project, and local configuration, while `strictMcpConfig` prevents ambient MCP discovery. Auto memory is explicitly disabled. `persistSession: false` disables transcript persistence; it is not a promise of no filesystem writes. The CLI still initialized its isolated config directory.

Managed host policy and certain credential restrictions can still apply. `settingSources` does not create an OS sandbox or restrict arbitrary file access. The complete [documented source-selection exceptions](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control) also cover global config, auto memory, and claude.ai connectors. This probe asserts the selected ordinary settings and lack of inherited authentication; it does not trace every filesystem access or prove total network silence.

## Authentication without configuration coupling

[Documented credential storage](https://code.claude.com/docs/en/authentication#credential-management) uses macOS Keychain, with an isolated Keychain service for a non-default config directory. The local handshake reported no authentication in all four cases. An API key or `CLAUDE_CODE_OAUTH_TOKEN` can be passed explicitly while keeping config/session directories separate. The [environment-variable reference](https://code.claude.com/docs/en/env-vars) describes generating a subscription token with `claude setup-token`; it is used for the session and must be replaced when expired. Passing an API key changes the billing path even when subscription credentials exist.

Source inspection reveals a read-only Keychain helper used when the SDK materializes externally stored sessions. For the ordinary production/default-config case it reads service `Claude Code-credentials` for the current user. Non-default config paths add the first eight hex digits of a SHA-256 path hash to the service name. That implementation detail can help investigate controlled token forwarding, but it is not a stable public credential API. This spike did not call the helper. It neither copied nor changed credentials. Sharing the entire normal config directory would couple state as well as authentication.

## Runtime surface and source reproducibility

The installed `Query` declarations expose interruption, streaming additional inputs, model/permission changes, session initialization details, context usage, background/stop task controls, file checkpoint rewind, and MCP status/reconnect/toggle/set operations. User interaction can be handled through `canUseTool` and explicitly supported dialog callbacks. Session resume/fork controls are present in launch options. This is stronger than parsing terminal output, but presence in the types is not proof that every feature behaves correctly; steering, quiescence, forks, and `/btw` parity need separate spikes.

Installed evidence paths are `spikes/001-claude-sdk-launch/node_modules/@anthropic-ai/claude-agent-sdk/{package.json,sdk.d.ts,sdk.mjs}`. Useful declaration anchors: `Options` at line 1526, environment at 1650, executable path at 1984, settings sources at 2271, `Query` at 2865, `SpawnOptions` at 9594, `startup` at 9634. The probe saves searched minified-source markers and their UTF-16 offsets in `source-excerpts.json`; it intentionally fails if those markers change after an upgrade. Hashes in the summary identify the exact installed distribution. The public documentation repository was at `85d8f8e0772199ec7965a0c2e874ac88343f2a01`, but that revision does not identify the SDK's internal source build.
