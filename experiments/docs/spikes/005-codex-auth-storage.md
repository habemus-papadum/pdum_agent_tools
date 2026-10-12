# 005 — Codex authentication profiles and thread persistence

## Questions and main result

Can an isolated app-server own its login, renew cloud credentials, and use a different thread backing store? **Separate login homes and renewable bearer-token commands work without a fork. A cloud thread store has a Rust extension point, but no stock app-server storage callback or supported remote-store URL.** Keep auth ownership and thread persistence as separate launcher responsibilities.

## Observed on installed Codex 0.162.1

The raw stdio probe used private temporary homes and a loopback Responses fixture, with **six synthetic model requests, no paid inference, and no access to the developer's credentials**:

- `account/login/start({type:"chatgpt"})` returned a normal authorization URL; we canceled it without opening a browser or completing sign-in. A real profile login remains an operator step.
- `account/login/start({type:"apiKey", apiKey:...})` stored a dummy key in a mode-0600 `auth.json`. A restarted app-server reused it. Replacing the key through the same RPC changed the bearer credential used by an existing thread's next request.
- A custom provider's `auth.command` read a dummy token from a file. Changing that file and waiting past `refresh_interval_ms` changed the next request's bearer token without restarting the server or creating `auth.json`. This validates the renewable-token mechanism, not a live AWS/OpenAI exchange.
- A completed thread survived process restart; `thread/resume` and `thread/fork` retained the assistant message. The next model request contained the earlier conversation. This probe supplies explicit read-only policy: restoring history does not imply preserving permissions (see [006](006-codex-permissions.md)). Local state included rollout JSONL, thread-history/state SQLite databases, queues, and writer locks.
- Experimental `thread/resume.history` accepted raw Responses items and put them in the next model request. Its initial response contained **zero visible turns**, so importing model context is not the same as restoring the complete UI/durable session.
- Incomplete native workload-identity configuration failed closed. Setting the obsolete `experimental_thread_store_endpoint` failed with an explicit “no longer supported” error.

## Authentication decision

**Development:** give each app-server profile its own persistent `CODEX_HOME` and perform a separate normal Codex login there. A config `--profile` is not a separate credential home. Prefer one renewal owner per home. Do not clone a managed `auth.json` into independent profiles: both copies could rotate the same refresh token without seeing each other's updates.

The earlier [003 isolation probe](003-codex-isolation.md) reused only an access token through `chatgptAuthTokens`. That mode does **not** automatically rotate the developer's refresh token: the host must answer the refresh callback. It is useful for short development probes, but needs an explicit credential owner for long-lived use. The pinned source marks that RPC internal/unstable even though the official documentation describes it as experimental.

**Cloud:** two different federation paths exist. Your existing **OpenAI API WIF** flow can feed a custom provider's token command, which performs AWS identity acquisition and OpenAI token exchange externally. Codex also has **native Codex/ChatGPT WIF** using `OPENAI_FEDERATION_RULE_ID` and `OPENAI_IDENTITY_TOKEN_FILE`; it exchanges the rotating assertion itself. These target different principals/authentication routes and are not interchangeable. See [official WIF guidance](https://developers.openai.com/api/docs/guides/workload-identity-federation) and the [configuration sketch and fixture evidence](../../spikes/005-codex-auth-storage/README.md#cloud-authentication).

## Storage decision

The pinned source defines a substantial `ThreadStore` Rust trait, including append, resume, durability barriers, fork preparation, pagination, and metadata. However, stock configuration selects only local storage or an internal in-memory implementation, and app-server fixes that selection at process startup. Replacing it with an object-store/database service requires Rust integration/plumbing, not a TypeScript protocol callback. Some ancillary features depend separately on SQLite.

For initial cloud deployment, the simplest **untested deployment recommendation** is one durable local/block volume per profile with a single writer, plus coordinated backups after shutdown. Do not assume a live SQLite directory can safely be copied to S3, or that a transcript of Level 1 notifications is a complete restore format. A remote `ThreadStore` deserves its own implementation spike if this becomes a requirement.

## Reproduce, evidence, limits

`pnpm spike:005` runs the fixture; `SPIKE_CODEX_BIN` selects an explicit alternative binary. Evidence: `artifacts/005-codex-auth-storage/run-1791814921127/`. Typecheck and all assertions passed. [Supporting notes](../../spikes/005-codex-auth-storage/README.md) include login recipes, source links, refresh/store caveats, and the intended DotSlash distribution approach for a future fork. Source pin: `6c372fbef45f730b6d8aa727b0ec8332365588db`; it is not asserted to be the installed binary's commit. Live AWS federation, managed OAuth renewal races, production cloud storage, and full browser sign-in were not tested.
