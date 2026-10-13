# Spike 016: profile and project configuration boundaries

**Question.** Can the unmodified Claude native worker load separate user-level
agents, commands and settings for two profiles in one workspace, while both
profiles still see the same project configuration? Can two active workers use
one profile without conflating their control streams?

**Result, 2026-10-13.** Yes for the tested discovery and control paths. Ten
credential-free native workers were launched through the existing Spike 014
launcher and controlled by the published browser SDK export under Node. Profile A
and B had separate `CLAUDE_CONFIG_DIR` values but the same synthetic `HOME`
and `cwd`.
Both initializations listed the shared project's `project-shared` agent and
command. A listed `user-a` and omitted `user-b`; B did the converse. A shared
project `outputStyle: Concise` appeared in both initialization responses despite
different user settings. After removing only that project settings fixture,
fresh workers reported the user values `Explanatory` and `Learning`, respectively.
These observations show project precedence for this setting in this version;
they are not a survey of every settings key or merge rule.

The shared synthetic HOME also contained a default `~/.claude` agent, command
and setting. Neither explicitly configured profile listed that agent or command.
A separate worker with the same HOME but **without** `CLAUDE_CONFIG_DIR` listed
the default-home agent and command, and neither Profile A nor B's user entries.
All paths were new fixtures under ignored artifacts; the developer's real HOME
and Claude configuration were never passed to a worker.

With slash commands enabled, the launch flag `--setting-sources=user` exposed
only Profile A's user agent/command and its `Explanatory` output style.
`--setting-sources=project` exposed only the shared project agent/command and
its `Concise` output style. `--setting-sources=` exposed neither custom tree and
reported the `default` output style. Built-in commands and agents remained
listed in all three cases. Thus the manager can choose whether project files
participate by the supported setting-sources knob; an empty list does not mean
an empty command inventory.

Two further workers started at once with Profile A's same config root, HOME and
workspace, but distinct native PIDs and explicit session IDs. Both discovered
the same agents, commands and output style. Simultaneous permission-mode,
MCP-status and discovery controls resolved. After stopping one worker, the
other remained alive and answered `interrupt`. The probe sent no user prompt,
received no assistant/result frame and made no inference request. Its estimated
model cost is zero; no provider billing record was inspected.

The main profile checks use the native CLI's supported
`--setting-sources=user,project` flag.
Spike 014's default launch recipe deliberately uses an empty setting-source
list and disables slash commands; this probe changes only those launch flags
and adds an explicit `--session-id`. The source matrix varies that one flag.
It does not patch SDK or CLI code. User
fixtures live in each isolated config root's `agents/`, `commands/` and
`settings.json`; the project fixtures live in the shared workspace's `.claude/`
tree. The project `CLAUDE.md` fixture was present but its prompt contents were
not tested by a model turn. The SDK's published `initializationResult()`,
`supportedAgents()`, `supportedCommands()`, `setPermissionMode()`,
`mcpServerStatus()` and `interrupt()` methods provided the observations.

The published package's root entry exports `listSessions`, `getSessionInfo`,
`getSessionMessages`, `forkSession`, `renameSession`, `tagSession` and
`deleteSession`. Its `/browser` entry exports none of those storage helpers.
The probe checked runtime export names and the package's public
`sdk.d.ts`/`browser-sdk.d.ts` declarations; it did not inspect native storage
internals. Therefore a browser controller needs a separate host management API
for these operations. Spike 014's storage work shows the Node helpers still
need a fixed per-profile process environment, so the manager should route
storage requests to the appropriate host helper.

Reproduce from `experiments/` after workspace dependencies are installed:

```sh
pnpm exec tsx spikes/016-claude-client-sessions/src/profile-probe.ts \
  artifacts/016-claude-client-sessions/profile-local
```

Use a fresh output directory. The script exports `runProfileProbe(outputDirectory)`
for the Spike 016 entry point. `profile-results.json` has the assertions and
version hashes; `separate-initialization.json`, `setting-sources-matrix.json`,
and `sdk-export-surface.json` have the relevant observations. Each
worker directory has `launch.json`, raw worker frames and SDK control frames.
The evidence from the final successful run is under the ignored
`artifacts/016-claude-client-sessions/profile-matrix-20261013/`. An initial
failed attempt in `profile-dev-20261013/` caught the project setting taking
precedence over both user settings; the final probe tests both phases explicitly.
These local paths are evidence locations, not published artifacts. Captures may
contain configuration or protocol data and stay ignored.

| Component | Observed version / digest |
| --- | --- |
| Agent SDK | `0.3.296`; Node bundle SHA-256 `5cf6f15237f9c84e6e5b724a10180478732457168921d7aa3e02632037cce299` |
| Browser SDK bundle | SHA-256 `7f5d8dc0108929f15215b17e8bb4fbdb944d0ec4303e76c562643206988d0536` |
| Bundled Claude Code | `2.1.296`; macOS arm64 executable SHA-256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` |
| Runtime | Node `v26.10.0`, Darwin arm64; observed 2026-10-13 |

The result establishes config discovery and independent control for these
isolated workers. It does not prove concurrent model turns or filesystem write
behavior when same-profile workers share a workspace, dynamic reload of changed
config in running workers, authentication isolation with real credentials, or
every native settings precedence rule. It also does not claim the browser SDK
has no possible storage mechanism beyond its published export; only this
published helper API is absent. The manager still needs to own worker
lifetimes and route one browser SDK controller to one worker. This probe stops
each worker directly; the client-disconnect policy is exercised elsewhere in
Spike 016.
