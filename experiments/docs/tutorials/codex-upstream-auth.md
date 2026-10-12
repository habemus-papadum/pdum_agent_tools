# Authenticate our Codex app-server to OpenAI

This tutorial covers the credential our **Node-launched Codex process sends upstream for model inference**. Authentication of a client connecting to an app-server WebSocket is a separate concern and is outside this tutorial.

Our launcher owns an explicit binary, a private persistent profile, the child process environment, and a bidirectional stdio connection. Codex owns the agent loop. Decide who owns the **upstream credential and its renewal** before launching work:

| Route | OpenAI identity / access | Renewal owner |
| --- | --- | --- |
| Managed ChatGPT login | Signed-in ChatGPT account/workspace and its Codex entitlements | Codex, using its stored login |
| Platform API key | API project credentials and usage-based access | Our secret-management process rotates the key |
| External `chatgptAuthTokens` | Existing ChatGPT auth supplied by a host | Host token broker; Codex asks it for replacements |
| API workload identity through `auth.command` | API Platform project service account | Our helper obtains external identity and exchanges it |
| Native Codex workload identity | User/service account in a managed ChatGPT workspace | Host rotates the identity file; Codex exchanges it |

**Default for our development setup:** a dedicated profile with its own normal ChatGPT login and one running credential owner. **For AWS automation already using API WIF:** a custom API provider backed by a renewable token helper. Native Codex WIF is a different, workspace-enabled route—not a way to reuse an API service-account mapping. These deployment choices are recommendations, not cloud results from this repository.

## 1. Make the profile boundary explicit

Use directories outside any agent-editable repository. The following macOS/Linux shell recipe prepares a new profile; replace the binary path. It does not alter the terminal shell's `HOME` or the developer's normal Codex profile.

```sh
CODEX_BIN=/absolute/path/to/codex
PROFILE="$HOME/.local/share/agent-spike/profiles/research"
umask 077
mkdir -p "$PROFILE/home" "$PROFILE/codex" "$PROFILE/work"
chmod 700 "$PROFILE" "$PROFILE/home" "$PROFILE/codex" "$PROFILE/work"
```

Put this **non-secret** configuration in that new profile's `codex/config.toml`:

```toml
model_provider = "openai"
model = "gpt-6-luna"
model_reasoning_effort = "low"
cli_auth_credentials_store = "file"
```

Choose an actually entitled model rather than silently falling back. `CODEX_HOME` selects config, credentials, sessions, and other state; a named `--profile` only selects configuration within a home. File storage gives this experiment an explicit boundary: protect `auth.json` as a password. OS keyring storage is also supported, but is not exercised by these recipes. Managed policy can constrain storage and login methods. [Authentication documentation](https://learn.chatgpt.com/docs/auth), [environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).

The Node launch fragment below is **illustrative integration code**, not a complete transport implementation. It assumes the directories and config already exist; the RPC client must read stdout continuously, frame newline-delimited JSON, route server requests separately, and keep stderr private.

```ts
import { spawn } from "node:child_process";
import { join } from "node:path";

const binary = "/absolute/path/to/codex";
const profile = "/absolute/private/profiles/research";
const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
  cwd: join(profile, "work"),
  env: {
    HOME: join(profile, "home"),
    CODEX_HOME: join(profile, "codex"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

Add only intentionally needed proxy/CA/helper/AWS environment variables. Do not blindly inherit the launcher environment: an unexpected credential selector or endpoint override can select the wrong identity or destination. Separate homes isolate config/state, not hostile processes running under the same OS user.

On the stdio connection, initialize before account requests:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_spike_launcher","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}
```

After its successful response, send `{"method":"initialized"}`. Experimental capability is needed for the external-token recipe below, not for every login type.

## 2. Development: let Codex own a dedicated ChatGPT login

Run the normal login **once for this profile**, then start the Node process with exactly the same HOME/CODEX_HOME and credential-store selection:

```sh
(
  cd "$PROFILE/work"
  env -i HOME="$PROFILE/home" CODEX_HOME="$PROFILE/codex" \
    PATH="$PATH" LANG=en_US.UTF-8 \
    "$CODEX_BIN" -c 'cli_auth_credentials_store="file"' login
)
```

Complete the browser ceremony yourself. If your network requires an explicit proxy or private CA, add those environment values deliberately. The login command and subsequent app-server must agree on credential storage. A separate login per profile is preferable to copying the developer's `auth.json`.

Alternatively, our application can own the login **UI** while Codex still owns the credentials:

```json
{"id":2,"method":"account/login/start","params":{"type":"chatgpt"}}
```

The result contains `loginId` and `authUrl`. Open that URL for the operator, retain the running app-server for its callback, and wait for `account/login/completed` with the matching `loginId` and `success:true`. Receiving a URL is not successful login. `type:"chatgptDeviceCode"` is the documented alternative when the browser callback is impractical; follow its returned verification URL/code. Treat those values as private ceremony data. [App-server authentication](https://learn.chatgpt.com/docs/app-server#authentication).

Check state without forcing renewal:

```json
{"id":3,"method":"account/read","params":{"refreshToken":false}}
```

Codex stores managed credentials and renews them during use. At the inspected pin, refresh uses an in-process semaphore plus a reload-before-refresh check—not a proven distributed lock. **Do not clone a managed refresh token into multiple independent homes and let each process rotate it.** Keep one renewal owner per profile, or obtain independent logins. All threads/subagents sharing that app-server share its account owner; a thread is not an authentication tenant. Drain active work before intentionally switching accounts. [Refresh implementation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/manager.rs).

## 3. API access: persist a key, or supply one to a custom provider

### Persist a Platform API key in the dedicated profile

Use the built-in `openai` provider. Have a secret manager provide `OPENAI_API_KEY` to this operator command; do not type a literal key into shell history:

```sh
printenv OPENAI_API_KEY | env -i \
  HOME="$PROFILE/home" CODEX_HOME="$PROFILE/codex" PATH="$PATH" LANG=en_US.UTF-8 \
  "$CODEX_BIN" -c 'cli_auth_credentials_store="file"' login --with-api-key
```

Or supply it in memory over the private RPC channel after initialization:

```json
{"id":4,"method":"account/login/start","params":{"type":"apiKey","apiKey":"<secret supplied by host>"}}
```

With file storage this persists the key to the dedicated `auth.json`; it does not become a ChatGPT subscription credential. Rotate through the same RPC or a controlled restart/login procedure. Spike 005 observed a replacement key being used by an existing thread's next fixture request. Static keys have no OAuth refresh flow. Never record this request unredacted. [Login types and serialization](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L64).

### Keep a static key in the launched process environment instead

Give the provider a **new ID**, not `openai`, and replace the profile's provider configuration:

```toml
model_provider = "openai_env"
model = "gpt-6-luna"

[model_providers.openai_env]
name = "OpenAI API with launcher key"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "AGENT_OPENAI_API_KEY"
supports_websockets = false
```

Add `AGENT_OPENAI_API_KEY` to the child environment from our secret manager. No `account/login/start` is needed for this provider. A parent-process environment update does **not** update an already-running child's environment; restart for rotation, or use the renewable helper in the next section. Environment credentials remain sensitive and may be available to subprocesses; this is not a secret-isolation mechanism.

The actual config key is **`requires_openai_auth`**, not `needs_openai_auth`. When true, the provider selects Codex-managed OpenAI authentication; custom providers default to false. At the pin, the built-in OpenAI provider has no `env_key`, and stock app-server explicitly disables the `CODEX_API_KEY` environment shortcut. Merely exporting `OPENAI_API_KEY` or copying an exec/SDK recipe is therefore not our app-server login procedure. Use one of the explicit routes above. [Provider definition](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/model-provider-info/src/lib.rs#L528), [app-server startup](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/lib.rs#L551).

Without endpoint overrides, managed ChatGPT auth chooses the ChatGPT Codex backend, while API-key auth chooses `api.openai.com/v1`. Moving an ordinary Codex subscription token to a custom API provider does not establish that provider's API entitlement; use the credential and endpoint combination supported by the selected authentication flow. `supports_websockets` changes the outbound Responses transport capability, **not** the credential class, identity, or billing account. [Endpoint selection](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/model-provider-info/src/lib.rs#L426).

## 4. If our host already owns ChatGPT tokens

`chatgptAuthTokens` is experimental in official docs and marked internal/unstable in the pinned source. It worked in our short live WSS probes, but it is not a stable promise for arbitrary third-party OAuth integrations. Prefer normal managed login unless we intentionally accept this maintenance boundary.

After experimental initialization, supply the host-owned access token and matching workspace/account identifier:

```json
{"id":5,"method":"account/login/start","params":{"type":"chatgptAuthTokens","accessToken":"<host-owned access JWT>","chatgptAccountId":"<matching workspace/account>","chatgptPlanType":null}}
```

Codex keeps this external auth in memory. It does not receive our refresh token or own the host's OAuth lifecycle. After an upstream authorization failure, it can issue this **server request**; answer using its ID, not a new request ID:

```json
{"id":"refresh-1","method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized","previousAccountId":"<workspace/account>"}}
{"id":"refresh-1","result":{"accessToken":"<replacement access JWT>","chatgptAccountId":"<same intended workspace/account>","chatgptPlanType":null}}
```

Our token broker must serialize its own renewal, verify the requested workspace, and return a fresh-enough token within the bridge's roughly ten-second timeout. Keep the receive loop running while obtaining it; return a sanitized RPC error if renewal fails. Never log token-bearing requests/results. `account/read({refreshToken:true})` does not refresh external tokens; proactively replace them with another `chatgptAuthTokens` login if our broker's lifecycle requires it. A copied access token alone is only a temporary probe arrangement, not a renewable identity system. [Refresh bridge](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/external_auth.rs), [account contract](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L544).

## 5. AWS → OpenAI API WIF → a renewable provider token

This route authenticates an **API Platform project service account**, not a ChatGPT user. It needs an OpenAI identity provider and matching service-account mapping. On AWS, an ordinary IAM role's access key/session credentials or a SigV4 request are not the subject token: use regional STS `GetWebIdentityToken` after enabling AWS outbound identity federation and granting that operation, or an EKS projected service-account JWT. Match issuer, audience, and restrictive subject/claim conditions. This is workload identity; a person's workforce SSO login is not a substitute for the mapping. [Official AWS setup](https://developers.openai.com/api/docs/guides/workload-identity-federation/aws).

The integration has two explicit stages:

1. Our trusted helper obtains a current external JWT using the workload's AWS identity, or reads the current projected EKS token.
2. It exchanges that JWT for an **OpenAI API access token** and prints only the resulting bearer token to Codex's pipe.

The following **Node pseudocode** shows the exchange contract; `obtainCurrentAwsOrEksJwt` and `requiredSetting` are host-owned functions, not APIs provided by this repository. Do not log the request body, returned JSON, or errors containing either token.

```ts
const subjectToken = await obtainCurrentAwsOrEksJwt();
const response = await fetch("https://auth.openai.com/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  signal: AbortSignal.timeout(10_000),
  body: JSON.stringify({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: subjectToken,
    identity_provider_id: requiredSetting("OPENAI_IDENTITY_PROVIDER_ID"),
    service_account_id: requiredSetting("OPENAI_SERVICE_ACCOUNT_ID"),
  }),
});
if (!response.ok) throw new Error("OpenAI token exchange failed");
const credential = await response.json();
if (typeof credential.access_token !== "string" || !credential.access_token ||
    typeof credential.expires_at !== "number" ||
    credential.expires_at <= Date.now() / 1000 + 120) {
  throw new Error("OpenAI token missing or too close to expiry");
}
process.stdout.write(credential.access_token + "\n");
```

A real helper needs bounded AWS acquisition, generic failure handling, correct trust/permissions, and an exit code on failure. The exchange returns expiry metadata but no refresh token; repeat with current external identity to renew. Retain absolute `expires_at` if introducing a broker/cache, rather than restarting a full lifetime when forwarding an old token. [API exchange reference](https://developers.openai.com/api/reference/workload-identity-federation), [renewal guidance](https://developers.openai.com/api/docs/guides/workload-identity-federation#renew-the-access-token).

Replace the profile's provider with this **configuration sketch** once the helper exists:

```toml
model_provider = "openai_wif"
model = "gpt-6-luna"

[model_providers.openai_wif]
name = "OpenAI API through workload identity"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.openai_wif.auth]
command = "/absolute/trusted/bin/openai-wif-token"
timeout_ms = 25000
refresh_interval_ms = 60000
cwd = "/absolute/trusted/helper-directory"
```

Pass the helper's AWS region/credential-chain settings and OpenAI mapping IDs into the app-server environment deliberately. The process executes the helper, so use an absolute trusted executable and a directory the agent cannot replace. The example assumes a returned token has at least 120 seconds remaining and a refresh check after 60 seconds; choose margins for actual token lifetimes, clock skew, and request duration.

Codex caches the helper's stdout token and reruns the helper when a subsequent credential resolution finds the interval elapsed, or on authentication recovery. This is not a guaranteed background timer. Zero interval disables proactive refresh—it does not run the helper on every request. Stdin is closed; stdout must contain only the token. Helper stderr can appear in failure messages, so never put secrets there. Do not combine command auth with `env_key`, `experimental_bearer_token`, or `requires_openai_auth=true`; leave the latter at its custom-provider default, false. [Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers), [refresh implementation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/external_bearer.rs).

**What we tested:** Spike 005 changed a dummy helper token between two HTTP/SSE fixture turns and observed the new bearer token, without `auth.json`. We did not test AWS exchange, API WIF inference, refresh-on-401, or token replacement on a long-lived upstream WSS connection. The `supports_websockets=false` sketch deliberately keeps that last unvalidated lifecycle out of the initial integration.

## 6. Native Codex/ChatGPT WIF is a different route

Use this only when the target is a **managed ChatGPT workspace principal** and administrators have enabled Codex WIF beta and created its provider/federation rule. An API project's `identity_provider_id` plus `service_account_id` is not this rule. The rule selects an existing ChatGPT user or service account with the required membership and entitlements. [Product distinction and availability](https://developers.openai.com/api/docs/guides/workload-identity-federation#use-workload-identity-with-codex), [Codex federation rules](https://developers.openai.com/api/docs/guides/workload-identity-federation/federation-rules).

Use the built-in `openai` provider, not the `openai_wif.auth.command` profile above. Add these two values to our Node child's environment before spawning it:

```ts
const nativeWifEnvironment = {
  OPENAI_FEDERATION_RULE_ID: "<Codex federation rule ID>",
  OPENAI_IDENTITY_TOKEN_FILE: "/absolute/private/current-identity.jwt",
};
```

That file contains the **external OIDC JWT or SPIFFE JWT-SVID**, not a Platform API access token. Our trusted host/sidecar maintains the file with restrictive permissions and safe replacement before expiry. Codex rereads it for exchanges, uses its native federation-rule protocol, and caches resulting short-lived ChatGPT access credentials in process memory. It is not calling our API-WIF helper or using the API service-account mapping. [Native integration](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/login/src/auth/workload_identity.rs), [exchange implementation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/workload-identity/src/exchange.rs#L173).

Set both selectors or neither: partial configuration fails closed. Do not run an account-login RPC to replace selected native WIF; login/logout replacement is rejected. Restart for a different selected identity, and keep the subject stable while rotating assertions. If assertion replay protection is enabled, the host must provide a fresh assertion for each exchange, including ambiguous retries—not simply leave one JWT until its expiry. [Environment contract](https://learn.chatgpt.com/docs/config-file/environment-variables), [rule replay behavior](https://developers.openai.com/api/docs/guides/workload-identity-federation/federation-rules#replay-protection).

We observed only incomplete native configuration failing closed. Successful native federation, AWS identities, and workspace authorization remain **unvalidated here**.

## 7. Validate the selected route without mistaking local state for access

1. Record binary version/hash, profile path, selected provider/model, and non-secret credential mode. Never record a whole environment, auth file, login URL, or token exchange body unredacted.
2. Initialize and inspect `config/read` and `account/read`. An API-key account proves local credential selection, not acceptance by OpenAI. A custom provider can report `requiresOpenaiAuth:false` while its upstream endpoint still requires the bearer token from `env_key` or `auth.command`.
3. Check `model/list`, then deliberately run one tiny low-cost turn with an exact entitled model and conservative permissions. Request a text-only answer and verify that no tools were called; a prompt is not an enforcement mechanism for disabling tools. Inspect terminal status, errors, and actual upstream route/model. Do not infer success from an authorization URL, an RPC acknowledgment, or a healthy process.
4. Test renewal separately with an expiring credential and a controlled failure. Our live external-token probes did **not** exercise the refresh callback. Never provoke expiry by rotating the developer's normal refresh token.

| Symptom | Check first |
| --- | --- |
| Fresh process is unexpectedly signed out | Correct HOME/CODEX_HOME and storage backend; whether the previous process used memory-only external auth |
| API key environment variable seems ignored | Built-in app-server versus explicit custom `env_key`; do not assume exec/SDK environment shortcuts |
| `account:null`, `requiresOpenaiAuth:false` | Custom provider's own auth mechanism; this is not proof of anonymous upstream access |
| External token renewal times out | Receive loop handles server requests; broker answers within ten seconds with the correct ID/workspace |
| Helper token works once, later fails | Remaining lifetime versus refresh interval; helper stderr hygiene; actual transport/reconnect behavior |
| Native WIF startup/login error | Both selectors, absolute readable identity file, allowed login method/workspace, and whether runtime replacement was attempted |
| Federation exchange rejected | Correct API mapping versus Codex rule, issuer/audience/subject, expiry, IAM permission, and workspace beta enablement |

## Evidence boundary

Written 12 October 2026. Source checked at `6c372fbef45f730b6d8aa727b0ec8332365588db`, separately from installed Codex `0.162.1`:

- [005](../spikes/005-codex-auth-storage.md): dummy API-key persistence/replacement, helper renewal over an HTTP/SSE fixture, browser-login start/cancel, and incomplete native WIF rejection.
- [010](../spikes/010-codex-live-subagents.md): successful live upstream WSS requests using externally supplied ChatGPT access tokens, including model-created children; no refresh lifecycle test.
- This tutorial adds documentation only. No login, credentials modification, model request, AWS token exchange, or native federation exchange was performed while writing it. The AWS helper is pseudocode and the deployment recipes require environment-specific setup.
