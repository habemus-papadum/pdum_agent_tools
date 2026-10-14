# Claude profiles and client sessions

The Claude launcher provides a Python management library and `pdum-claude` CLI.
The official TypeScript Agent SDK remains in the browser or Node client. Each
connected client controls its own native Claude worker; several workers can share
a profile. Disconnect ends the worker, while its saved conversation remains on disk.

This is a new, unreleased package. See the [specification](specs/claude-launcher.md),
[delivery plan](plans/claude-launcher.md) and [qualification report](claude-validation.md).
Browser and Node compatibility have each passed live checks against the Python host.
The [2026-10-13 checkpoint](claude-handoff.md) records the stopping point and the
prioritized work to pick up next.

## Setup and authentication

From the repository root, `./scripts/setup.sh` installs the workspace and optional
adapters. Standalone installation will use
`habemus-papadum-claude-launcher[management]` after publication. Install/select the
native `claude` executable separately; the launcher uses that explicit selection,
not the Python SDK's bundled binary. The Python SDK dependency supplies public
saved-history functions.

```sh
uv run pdum-claude profile create research --workspace /path/to/project --auth native
uv run pdum-claude --profile research auth login
uv run pdum-claude --profile research auth status
uv run pdum-claude --profile research launch
```

Creation uses a Rich preview and Questionary selectors when attached to a terminal.
`--no-interview` is deterministic for scripts. Canceling an interview does not write
a profile or start login. `--login` explicitly starts native login after saving.
Use `--profile-dir PATH` instead of a name to select a directory; `--profiles-dir`
changes the root for named profiles. `profile list --json` and `profile show` return
metadata without resolving credentials.

| Authentication | Profile creation option | Behavior |
| --- | --- | --- |
| Dedicated Claude account | `--auth native` | `auth login` runs `claude auth login --claudeai` in the profile environment. Browser/code entry stays in the host terminal's native flow. |
| API key | `--auth api-key --api-key-env MY_ANTHROPIC_KEY` | Resolve that environment variable when a worker starts; persist only its name. |
| Existing login reuse | `--auth reuse-login` | Read an existing access token at launch, inject it into this worker, and do not modify or refresh the source. |

On macOS, default login reuse reads the ordinary Claude Keychain entry; otherwise
it reads the ordinary Claude credential file. `--source-directory` selects a native
credential-file directory explicitly. A custom directory's hashed Keychain service
is not reverse-engineered. Authentication status distinguishes native presence from
a successful model request; expired borrowed tokens require renewing the source
login. API keys, account login and provider federation are distinct strategies.
Bedrock and federation adapters are not yet implemented.

Native Claude documents directory-associated Keychain credentials for Claude-account
login. Console keyless sign-in has different storage semantics, so the initial
login command deliberately selects Claude-account login. Dedicated-profile login
and a subsequent live Node SDK turn have passed; credential refresh remains
unqualified. [Native credential management](https://code.claude.com/docs/en/authentication#credential-management)

## Profile configuration

Each profile contains `profile.json` for launcher-owned choices, `claude/` as its
native `CLAUDE_CONFIG_DIR`, and `anthropic/` as its `ANTHROPIC_CONFIG_DIR`.
Native `claude/settings.json`, agents, commands and other configuration remain
native. `--native-settings PATH` copies a settings file byte-for-byte, including
unknown fields. Broader selective imports and an existing-profile configuration
interview are not implemented yet.

`--setting-sources user,project` is the creation default. Project settings are
deliberately shared by workers using that workspace; `--setting-sources user`
selects only profile user settings. This prevents accidental config collisions,
not host-policy enforcement or filesystem sandboxing. Native fixture tests verify
separate user agents, commands, skills, instructions, plugins and MCP configuration;
selected project configuration is shared. `local` must be selected explicitly to
include `.claude/settings.local.json` and `CLAUDE.local.md`. See the
[isolation report](claude-profile-isolation.md) for tested behavior and limits,
including managed policy and authenticated customization syncing.
Credentials never go to browser clients.

Temporary work is available through `launch --temp --workspace PATH`. Its default
auth is `reuse-login`, with a concise warning. `--auth api-key` or `--auth native`
selects another strategy. Temporary profiles are removed after the foreground
manager and workers stop; use a named profile when saved history should survive.

## Launch and management

The foreground CLI listens on `0.0.0.0:8765` by default. Override `--host` and
`--port` as needed; `--port 0` selects an available port and prints the actual
endpoint. `launch --all-profiles` registers all profiles under the selected
root; one selected profile is sufficient for multiple concurrent clients. Workers
start only when their allocated WebSocket is attached. Closing the SDK, losing the
connection, explicit stop or manager shutdown ends the owned worker. There is no
arbitrary idle expiry, durable worker recovery or automatic prompt replay.

```sh
uv run pdum-claude status --endpoint http://127.0.0.1:8765
uv run pdum-claude stop WORKER_ID --endpoint http://127.0.0.1:8765
uv run pdum-claude --profile research sessions list
uv run pdum-claude --profile research sessions read CONVERSATION_ID
uv run pdum-claude --profile research sessions rename CONVERSATION_ID 'A title'
uv run pdum-claude --profile research sessions fork CONVERSATION_ID
```

| HTTP operation | Purpose |
| --- | --- |
| `GET /api/profiles` | Configured profile metadata |
| `GET /api/status` | Owned workers, observation health and public usage estimates |
| `POST /api/workers` | Allocate `{profileId, resume?, options?}` and return `websocketUrl` |
| `GET /api/workers` or `/api/workers/{id}` | Active and completed worker status |
| `DELETE /api/workers/{id}` | Stop this worker |
| `GET /api/profiles/{id}/sessions` | List saved conversations without model inference |
| `GET` or `PATCH /api/profiles/{id}/sessions/{sid}` | Read messages/metadata or rename with `{title}` |
| `POST /api/profiles/{id}/sessions/{sid}/fork` | Fork with optional `{title, upToMessageId}` |

Live worker envelopes use `profileId`, `conversationId` and `websocketUrl`.
History results retain official Python SDK field names such as `session_id`.
Listing excludes worktrees; SDK read/info helpers may locate same-repository
worktree history within the selected profile. Profiles remain separate.

Supported per-worker `options` are `model`, `permission_mode`, `sandbox`, `tools`,
`max_turns`, and `max_budget_usd`. Defaults bypass permission prompts, disable the
native sandbox and leave turn/spend limits unset. Host-selected environment and
native executable settings belong to the manager. Node SDK spawn options do not
automatically become remote-worker launch options.

Resume is an explicit new allocation with a saved conversation ID. Fork creates
new saved history, not a workspace copy. Concurrent native writers to the same
conversation are unqualified; use separate conversations/forks for independent
work. One SDK controller owns each worker; shared-worker viewers and coordinated
multiple controllers remain future work.

## Python composition and official clients

```python
from pathlib import Path
from pdum.claude_launcher import ClaudeManager, load_profile, open_relay


async def run(application_ready):
    profile = load_profile(Path("/path/to/profile"))
    async with ClaudeManager({"research": profile}) as manager:
        async with open_relay(manager) as relay:
            worker = await manager.allocate("research")
            await application_ready(relay.worker_url(worker.id))
```

`management.create_app(manager)` supplies FastAPI routes over that same owner.
Its lifespan owns only storage helpers. The embedding application closes workers
and observers. When hosting with Uvicorn, disable its default WebSocket message
size limit (`ws_max_size=None`) and configure ping/pong liveness. The CLI does this.
Importing/mounting the CLI does not spawn processes or install signal handlers.

The [browser and Node examples](https://github.com/habemus-papadum/pdum_agent_tools/tree/main/examples/claude-client)
pin the official SDK. Build the example and pass
`--example-dir examples/claude-client/dist` to `launch`; open `/example/` on the
manager. The browser SDK uses its native WebSocket option; the Node entry uses
the public `spawnClaudeCodeProcess` transport adapter. Both keep conversation
controls and hook callbacks inside the official client query.

The browser page offers profile selection, saved-history browsing, new/resume/fork,
rename, streamed conversation text, interrupt and end-session controls. Reading
history starts no worker. Sending a message can incur model usage; ordinary chat
inherits the manager's defaults without probe turn or spend limits. Separate tabs
can use the same profile. Tab closure ends the owned worker; lost prompts are never
automatically replayed. Actual Chrome checks passed a live API-key turn, history
selection, rename, resume/fork initialization, profile switching and tab-close
cleanup. The four-turn browser probe also passed concurrent workers and marker
recall after fork/resume. Mid-turn UI interruption remains unqualified.

The browser build currently needs a small `process` shim. Native terminal attach,
desktop/phone Remote Control and live Python SDK clients are not supported by this
delivery. The small browser example displays text and tool details; file/image input,
AskUserQuestion, native dialog forms and MCP elicitation forms remain unsupported.
Unsupported forms are visibly cancelled; simple tool-permission controls are
implemented but still unqualified in a real browser.

## Observation and MITM

`--record NEW_FILE` enables complete client-protocol recording. Bytes are copied
into separate processor queues; decoding and disk I/O are off the forwarding path.
`/api/status` reports queue bytes, processing lag, failures and actual loss. Public
result events supply usage and cumulative conversation cost estimates. Repeated or
resumed cumulative totals must not be summed as new spend. Missing results remain
unknown, and SDK estimates are not inspected subscription bills.

The async library exposes `ObservationHub`, `JsonlRecorder`, `UsageObserver` and
the small `Processor` hook. Processors are cooperative; there is no hard fault
containment for arbitrary blocking plugins. Recording preserves full observed
chunks without payload quotas. A shutdown drain timeout reports loss. Raw captures
may contain credentials and must remain outside Git/public CI.

`--mitm --capture-dir PATH --capture` composes the independent MITM sidecar using
process-scoped proxy/CA settings. Without `--capture`, interception starts with
recording off. There are no global proxy or CA changes. The Python sidecar handle
supports runtime capture control; the Claude CLI does not yet expose capture toggle
commands. MITM and protocol recording are different observation surfaces.
