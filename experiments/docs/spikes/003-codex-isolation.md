# 003 follow-up — Raw app-server isolation and configuration scope

## Questions and result

Can we reuse the developer's ChatGPT authentication without loading their normal Codex settings, MCP servers, or skills? **Yes, on this machine.** Are integrations global or per-thread? **Layered: process defaults, working-directory discovery, and thread overrides all matter.** No SDK or Rust changes were needed.

## Observed, 2026-10-12

The installed **`codex-cli 0.162.1`** passed this probe. We did not rebuild; the earlier unmodified Rust build took **3m 58s**.

- Launched `codex app-server --listen stdio://` with fresh `HOME`, `CODEX_HOME`, and working directory outside the repository, plus an environment allowlist. `config/read` showed only our session flags, an empty isolated user layer, and an empty `/etc/codex/config.toml` layer. Initial MCP and skill inventories were both empty.
- Set `cli_auth_credentials_store="file"`, `features.apps=false`, `features.plugins=false`, and `skills.bundled.enabled=false`; disabled analytics and feedback. Fresh directories alone should not be confused with disabling Codex's bundled skills. No normal developer configuration or skill directories were copied.
- Read the existing access token and account ID into memory and sent the raw RPC below after opting into experimental APIs during initialization. `account/read` recognized ChatGPT authentication and **`account/rateLimits/read` succeeded against the service**. No `auth.json` was created in the isolated home. The source auth file was byte-for-byte unchanged. No refresh token was passed, and no model inference was requested.
- Started two ephemeral threads in one process. Only thread A received `config: {"mcp_servers.scope_fixture": {command: ..., args: [...]}}`. `mcpServerStatus/list` with A's `threadId` returned a connected local fixture with `fixture_ping`; B and the process-global query both returned zero servers.
- `skills/list` returned one fixture skill for a directory containing `.agents/skills/scope-fixture/SKILL.md`, and zero for the clean directory. `skills/config/write` disabled it and wrote the setting into the **isolated home** `config.toml`. Subsequent discovery returned that skill with `enabled: false`, not removed from the inventory.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"my_client","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/login/start","params":{"type":"chatgptAuthTokens","accessToken":"<existing access token>","chatgptAccountId":"<existing account ID>"}}
```

Wait for each request's response before the next step. Credentials must not appear in saved protocol transcripts. In external-token mode, the host owns renewal and handles `account/chatgptAuthTokens/refresh`; this bounded probe rejects refresh rather than touching the developer's login. See the [official OpenAI app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#3c-log-in-with-externally-managed-chatgpt-tokens-chatgptauthtokens).

## Where configuration lives

| Concern | Scope and control |
| --- | --- |
| Auth | Shared by the app-server process, not selected separately per thread. External-token login separates credentials from local config/storage. |
| MCP defaults | Config layers establish defaults; process `-c` options can override them. |
| MCP thread differences | `thread/start.config` supplies thread overrides. `mcpServerStatus/list({threadId})` inspects that thread; omitting it inspects global configuration. The two-thread difference above was observed. |
| Skills | Discovered from configured/user/project/plugin roots and the working directory, with shared process services/caches—not just a single fixed process-wide list. `skills/list` is cwd-oriented, not a thread-effective inventory API. |
| Skill enablement | `skills/config/write` persists a user-level setting in this process's `CODEX_HOME`; it is **not** a per-thread write. Source inspection also shows thread/session `skills.config` overrides and `skills.include_instructions` feeding turn configuration. Their effect during inference was not tested. |

The pinned source supporting the scope distinction is `vendor/codex` at `6c372fbef45f730b6d8aa727b0ec8332365588db`: `codex-rs/app-server/src/request_processors/{thread_processor,mcp_processor,catalog_processor,account_processor}.rs`, `codex-rs/config/src/skills_config.rs`, and `codex-rs/core/src/session/turn_context.rs`. This is source evidence from our pin, not a claim that the installed binary was built from that exact commit. The [official protocol documentation](https://learn.chatgpt.com/docs/app-server) describes the corresponding RPCs.

## Reproduce and limits

Run `pnpm --filter @agent-spike/003-codex-control isolation`. Override the executable with `SPIKE_CODEX_BIN=/absolute/path/to/codex`. The probe uses only Node APIs and newline-delimited JSON over stdio. Evidence: `artifacts/003-codex-control/isolation-1791812053920/{level-0.json,level-1.jsonl,result.json,stderr.json}`. Typecheck and the live-auth/configuration assertions passed.

This isolates ordinary developer settings, **not all host policy or filesystem access**: system/MDM/enterprise requirements can still apply, and pointing a later thread at a real project can discover its configuration and skills. An empty table override is not a reliable way to erase inherited nested config. A fresh process/home per copilot is the simplest starting boundary; use thread overrides within it. No inference, token renewal, active-thread config reload, or per-thread skill prompting was tested. The rate-limit request verifies authentication, not model entitlement. Temporary homes are private and retained for inspection; credentials are neither copied there nor included in the redacted evidence.
