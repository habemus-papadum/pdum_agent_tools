# 005 — Authentication profiles and storage boundaries

Run `pnpm spike:005` from the repository root. The implementation uses Node APIs and the raw app-server protocol, not a Codex SDK. It defaults to the resolved `~/.local/bin/codex`; set `SPIKE_CODEX_BIN=/absolute/path/to/codex` to change it. The [summary](../../docs/spikes/005-codex-auth-storage.md) separates observations, source findings, and recommendations.

All credentials in this probe are deliberate dummy strings sent only to a loopback fixture. It never reads the developer's normal `auth.json`. A normal browser-login ceremony is initiated and immediately canceled: the returned URL is redacted, and no browser is opened. Private temporary profile directories and ignored artifact directories are retained for inspection. These are narrow experimental clients, not a production transport library.

## Development profile login

A launcher profile should identify a binary and a persistent directory, rather than just a named TOML config profile. In particular, `--profile` selects configuration; `CODEX_HOME` locates credentials, sessions, and other state. A profile directory must not be inside a repository the agent can casually commit or distribute.

An operator could sign in once using an explicit binary and isolated home:

```sh
export CODEX_BIN=/absolute/path/to/codex
export HOME=/absolute/private/profiles/research/home
export CODEX_HOME="$HOME/.codex"
mkdir -p "$CODEX_HOME"
chmod 700 "$HOME" "$CODEX_HOME"
cd /absolute/private/profiles/research/work
"$CODEX_BIN" -c 'cli_auth_credentials_store="file"' login
```

Alternatively, the launcher can drive `account/login/start` with `{ "type": "chatgpt" }`, open its returned URL in the user's browser, and await `account/login/completed`. The probe exercises only URL creation and cancellation. The service thereafter starts with the **same** `CODEX_HOME` and file-store selection. Repeat the actual sign-in ceremony for another profile; do not copy an existing refresh token into that profile. File-backed auth makes the boundary explicit; keyring storage is also supported, but was not exercised here. The real launcher should create and validate all profile paths before starting either ceremony.

For API keys, send `account/login/start` with `{ "type": "apiKey", "apiKey": "..." }` over the private protocol channel. Avoid command-line secret values. This persists credentials using the selected storage backend; `account/read` recognizing an API key is not proof that the remote service accepts it. Our fixture verifies only correct persistence and HTTP bearer propagation. Static API keys have no OAuth refresh lifecycle.

### Who renews what?

Pinned source evidence lives in `vendor/codex/codex-rs/login/src/auth/manager.rs`:

- Managed ChatGPT auth checks JWT expiry with a five-minute refresh window; an eight-day last-refresh fallback is used when expiry cannot be obtained. Renewal persists returned access/refresh tokens and updates the in-memory cache.
- `refresh_token` uses an `AuthManager`-local semaphore, reloads matching-account credentials, and skips renewal when storage already changed. This helps cooperating readers but is **not** a demonstrated cross-process refresh transaction. The file backend writes the auth file directly; no cross-process refresh lock was found in the inspected auth path.
- Separate copied homes defeat even that reload coordination: each retains its own stale refresh token. A reused/rotated-token error is explicitly handled in source. We did not force a real renewal race or invalidate the user's login.
- External `chatgptAuthTokens` supplies only an access token/account identity. App-server requests renewal from its host with `account/chatgptAuthTokens/refresh`; the host can obtain the current token from a single owner instead of letting every instance independently rotate one refresh token. The raw RPC is experimental and source-marked internal/unstable.
- A dedicated profile with one app-server renewal owner is the straightforward default. Multiple clients can share that owner's process; they also share its account, so do not treat threads as separately authenticated tenants.

Source: [auth manager](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/manager.rs), [auth storage](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/storage.rs), [external-auth bridge](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/external_auth.rs).

## Cloud authentication

### Existing OpenAI API workload-identity federation

The token helper below is an **integration sketch, not an implemented or validated AWS deployment**. Your trusted helper acquires the AWS-issued OIDC identity, exchanges it for a short-lived OpenAI API access token, and prints only that bearer token. Codex's custom provider calls the helper again as needed:

```toml
model_provider = "openai_wif"
model = "<API-entitled-model>"

[model_providers.openai_wif]
name = "OpenAI API through workload identity"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.openai_wif.auth]
command = "/absolute/trusted/bin/openai-wif-token"
timeout_ms = 15000
refresh_interval_ms = 240000
```

The interval is illustrative: it must fit the **remaining** token lifetime and request duration. The helper must return a fresh-enough token, avoid secrets on stderr, and handle AWS/OpenAI failures. Do not combine command auth with `env_key`, a static `experimental_bearer_token`, or `requires_openai_auth=true`. Unlike command auth, an inherited environment variable cannot be updated by changing the parent process's environment after launch. The provider may also need project/organization headers appropriate to the user's API setup.

Observed locally: `/bin/cat` as the helper and a 100 ms refresh interval delivered token A, then token B, to two consecutive fixture turns. No auth file was written. This is positive evidence for token rotation plumbing; AWS roles, account entitlement, IAM rules, OpenAI exchange, and refresh-on-401 were not exercised. Source also reruns command auth on the authentication recovery path. A zero refresh interval disables proactive renewal; it does not mean “run on every request.”

The [official custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) documents command-backed tokens. [AWS federation guidance](https://developers.openai.com/api/docs/guides/workload-identity-federation/aws) distinguishes AWS STS-issued OIDC tokens / EKS service-account tokens from raw AWS access keys or SigV4 requests; your helper must supply the supported identity form.

### Native Codex/ChatGPT workload identity

The current source and installed binary also recognize:

```sh
OPENAI_FEDERATION_RULE_ID=<codex-federation-rule>
OPENAI_IDENTITY_TOKEN_FILE=/absolute/private/identity-token
```

This is a separate route targeting a **ChatGPT workspace principal**, not the API project's service-account token exchange above. The host keeps the external assertion file current. Codex reads it afresh for each exchange, sends the selected federation rule and assertion to its trusted auth endpoint, caches only the resulting short-lived access token in memory, and coordinates exchanges within the process. The source rejects a change of subject during the session and does not permit runtime replacement/logout of selected WIF auth. Supplying only one selector fails closed instead of falling back to another credential; that behavior was observed with the installed binary.

A successful native exchange needs the appropriate configured provider/rule/principal; merely having an API WIF mapping is not evidence that this path is configured. No real federation exchange was attempted. See [WIF route comparison](https://developers.openai.com/api/docs/guides/workload-identity-federation), [Codex federation rules](https://developers.openai.com/api/docs/guides/workload-identity-federation/federation-rules), and [documented environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).

Source: [provider token command](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/external_bearer.rs), [native WIF integration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/workload_identity.rs), [exchange and cache](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/workload-identity/src/exchange.rs).

## Thread backing store

### What is on disk?

The local implementation records canonical replay items in rollout JSONL under `$CODEX_HOME/sessions/`, with SQLite-backed state, paginated history, and ancillary stores. The probe observed `state_5.sqlite`, `thread_history_1.sqlite`, queue/goals/memories databases, rollout files, and writer-lock files. It closed one app-server, restarted with the same profile, resumed by thread ID, forked to a new ID, and verified the old assistant content in the following model request. Filesystem changes, shell processes, external infrastructure, and credentials are not restored by restoring conversation history.

History behavior is version-sensitive. In this release, experimental raw-history import created a paginated thread and returned `turns: []`, yet the imported assistant text reached the next model request. That initially broke a UI-transcript assertion; the probe now validates the model request itself. Raw `ResponseItem` history and app-server `ThreadItem` notifications are different types. Experimental `thread/resume.history` is source-marked for Codex Cloud, not a supported general storage-provider interface or full snapshot/restore contract.

### Can we replace it?

**Inside Rust, yes in principle:** `codex-thread-store` defines a storage-neutral `ThreadStore`, and core `ThreadManager::new` accepts `Arc<dyn ThreadStore>`. It is already a better integration boundary than replacing miscellaneous file writes. The trait includes authoritative resume context, appends, metadata, pagination, fork preparation, flush/shutdown, and durability semantics. Remote implementations must preserve writer ownership and ordering—not just save arrays of messages.

**Through the stock protocol/config, not as a general custom backend:** app-server constructs the store once from startup config; later thread overrides do not move it. The available variants at the pin are `local` and an internal/test `in_memory`. The old `experimental_thread_store_endpoint` is explicitly rejected, including in our installed-binary probe. `InProcessStartArgs` does not directly offer a custom thread-store field either, so exposing your implementation requires additional Rust startup plumbing or a fork. The source test named `remote_thread_store.rs` uses an in-memory test double; its name is not evidence of a shipped cloud store.

Also budget for separate services: queue persistence currently requires SQLite, and some project/section/metadata operations have local-state dependencies. A remote thread-store implementation does not automatically externalize auth, workspaces, logs, tools, or all ancillary application state.

An initial cloud deployment can keep stock Codex and use one persistent block/local volume per profile, with intentional shutdown/checkpoint and backup/restore ownership. This is an architectural recommendation, not a deployment test. Avoid concurrently mounting the same live SQLite state across arbitrary hosts, and do not mistake object-store synchronization for transactional storage. A future dedicated spike should implement a minimal remote `ThreadStore`, test restart/fork/durability/concurrency, and enumerate unsupported ancillary RPCs before choosing a production backend.

Source: [storage trait](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/thread-store/src/store.rs), [local implementation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/thread-store/src/local/mod.rs), [process-scoped selection](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/message_processor.rs), [configuration variants](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/config/src/config_toml.rs), [history import contract](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).

## Distribution if we maintain a fork

The intended distribution mechanism is **DotSlash**. The pinned Codex repository already has a release job publishing DotSlash manifests, with separate `codex` and `codex-app-server` outputs across macOS, Linux, and Windows. A future fork could follow that pattern to select an exact packaged executable independently of a user's terminal installation. This does not require building a TypeScript SDK around the Rust internals: our launcher can still speak the raw protocol to the selected executable. No custom release, manifest, or packaging pipeline was created in this spike.

Source: [DotSlash output configuration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/.github/dotslash-config.json), [release workflow](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/.github/workflows/rust-release.yml).
