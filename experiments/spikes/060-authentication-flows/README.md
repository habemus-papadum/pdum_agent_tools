# Authentication flows — interaction study

**060 · disposable simulation · 19 October 2026.** Choose Codex or Claude, an
explicit local/remote host, and one of three prepared fixture profiles. The view
makes the process owner, browser location, credential source and result location
visible before an attempt. Advance a synthetic native response, inspect status,
and separately simulate model access. Try cancellation, expiry, failure and a
lost connection from the study popup.

No credential files, Keychain, login/browser flows, profiles, workers or provider
APIs are touched. There is no free-text secret field: the API selector contains
three synthetic environment-variable names. No provider URLs are opened. All
profile paths start at `/mock/` or `/srv/mock/`, and all outcomes are fixtures.
This page deliberately omits the provider-capable development dock; it retains
the shared command palette and its own AIUI toolkit.

## Run

From `experiments/`, with the root `.dev/aiui` source link and research workspace
dependencies installed:

```sh
node spikes/055-orchestrator-mock-lab/serve.mjs
```

Open the printed URL at `/060-authentication-flows/` (also `/auth/`). The shared
host owns installation, source compilation and navigation. `Space` opens the
command map; `n` starts, `a` advances, `c` cancels/stops watching, `v` simulates
model access, and `r` resets. Native selects retain their keyboard behavior.

## Configuration and operation map

The selected profile is a **prepared fixture input**, not an application-owned
configuration scheme. Codex native TOML and Claude native settings remain owned
by their existing packages. Changing a strategy selects another fixture profile;
it does not edit the original one. A running receipt freezes its own selection.
Full creation/editing belongs to Round B, spike 063.

These commands are previews only. `P`, `S`, and `W` below mean explicit profile,
source and workspace paths on the **selected host**. The visible preview expands
them into shell-quoted synthetic paths. `uv run` commands run from this repository
root. A creation example is **provenance**, with an absent-target precondition;
it is not an instruction to recreate the selected existing fixture.

| UI choice | Existing operation / command | Existing field or owner |
| --- | --- | --- |
| Codex API reference | `uv run pdum-codex --profile-dir P auth configure --no-interview --method api-key --env OPENAI_API_KEY`; `AuthSpec("api-key", api_key_env=…)` through `ProfileEdit(import_assets=False)`, prepare/save | Native `config.toml` → `model_providers.<owned>.env_key`; `.pdum/launcher.toml` → `environment.inherit_keys`. Only the reference name is saved. |
| Codex existing-login reuse | Creation: `uv run pdum-codex --profile-dir P profile create --from-codex-home S --copy-auth --auth chatgpt --no-interview`; `ProfileEdit.copy_auth` | A file-backed `auth.json` snapshot in the new Codex home. Never a link or source write. There is no `--auth reuse-login` method. |
| Codex dedicated login | `uv run pdum-codex --profile-dir P auth configure --no-interview --method chatgpt`, then `… auth login [--device-auth]`; `login_auth` → `login_chatgpt` | Native `model_provider = openai`, file-backed credential store and target `auth.json`. Existing custom `model_providers.openai` can conflict. |
| Claude API reference | Creation: `uv run pdum-claude --profile-dir P profile create --workspace W --auth api-key --api-key-env ANTHROPIC_API_KEY --no-interview`; `create_profile(…, auth=AuthSpec(…))` | Existing `profile.json.authentication.api_key_env`; `build_environment` resolves on the host into child `ANTHROPIC_API_KEY`. No existing-profile auth-configure CLI is exposed. |
| Claude existing-login reuse | Creation: `… profile create --workspace W --auth reuse-login --source-directory S --no-interview`; `AuthSpec("reuse-login", source_directory=…)` | Existing `profile.json.authentication.source_directory`; token borrowed into child `CLAUDE_CODE_OAUTH_TOKEN`. No source write, copy or managed refresh. Without `S`, ordinary macOS Keychain/file fallback belongs to the launcher. |
| Claude dedicated login | Existing native fixture: `uv run pdum-claude --profile-dir P auth login`; `login_auth(profile)` invokes `claude --setting-sources user,project auth login --claudeai` | Native credential store associated with `P/claude` (`CLAUDE_CONFIG_DIR`), plus `P/anthropic` (`ANTHROPIC_CONFIG_DIR`). Native browser/code interaction stays in the host terminal flow. |
| Inspect status | `uv run pdum-{codex,claude} --profile-dir P auth status` | Codex describes configuration/auth-file presence with `authenticated = "not checked"`; Claude invokes native status, which does not prove inference or refresh. |
| Model-access validation | **Synthetic outcome only**; no launcher command is invented | Future live validation must make its real request, model, owner and spend explicit. It remains separate from native status. |
| Remote completion / cancellation / renewal | **Proposal / unqualified**; no mock endpoint or fabricated remote flag | Existing CLI/library operations remain host-local. A local browser is not the remote credential owner. Stopping observation cannot establish that a remote process stopped. |

Source owners inspected before UI work:

- [Codex authentication](../../../packages/codex-launcher/src/pdum/codex_launcher/authentication.py),
  [CLI](../../../packages/codex-launcher/src/pdum/codex_launcher/cli.py),
  [profiles](../../../packages/codex-launcher/src/pdum/codex_launcher/profiles.py),
  [configuration guide](../../../docs/profiles.md).
- [Claude authentication](../../../packages/claude-launcher/src/pdum/claude_launcher/authentication.py),
  [CLI](../../../packages/claude-launcher/src/pdum/claude_launcher/cli.py),
  [profiles](../../../packages/claude-launcher/src/pdum/claude_launcher/profiles.py),
  [configuration guide](../../../docs/claude.md).

Native Codex owns refresh of a dedicated login or copied token; independent refresh
owners can invalidate either copied session. Claude borrowed access-token refresh
is unmanaged. Dedicated Claude login plus a live SDK turn was qualified in earlier
work, but refresh was not. This study adds no new provider qualification.

## Scope decisions

| Question | Evidence / owner and status | Needed by |
| --- | --- | --- |
| Which auth strategies come first? | Already answered: API references, explicit reuse, native dedicated-profile login. Launcher packages own their meanings. | Applied now. |
| Can the UI invent an editable auth configuration? | Already answered: use existing fields and commands. Prepared fixture selection avoids claiming Claude has an edit workflow. | Profile workbench 063. |
| How should browser/host ownership appear? | Explore here: an ownership strip plus source, browser, result and refresh facts; provider-specific wording remains visible. | Round A review. |
| Which framework/state structure? | Delegated: Solid 2 + source-linked AIUI controls/actions; pure reducer, durable store, disposable cells. | Implemented in this study. |
| Can remote cancellation claim success? | No host protocol is implemented; the fixture reports unknown and does not retry automatically. | Live coordinator/auth control, with operator-assisted qualification. |
| Which renewal experience and model-access probe? | Deferred: native/source owners are named, but no refresh endpoint or model request command is invented. | Before live auth integration. |

[RC-07](../../../docs/runtime-contracts.md#rc-07--observation-and-recovery-have-gaps)
contributes the unknown-outcome/no-blind-replay acceptance case.
[RC-08](../../../docs/runtime-contracts.md#rc-08--lifetimes-are-provider-specific)
contributes provider-specific ownership and no invented common cancellation or
refresh guarantee. Those contracts describe the wider runtime; this simulation
is not evidence of actual login-process behavior.

## Implementation and acceptance

- `src/model/auth.ts`: pure operation previews, frozen receipts and explicit
  transitions. Terminal outcomes never advance or retry themselves.
- `src/model/store.ts`: scoped controls/actions and durable receipt. The only
  API-name input is enum-limited, including through the agent toolkit.
- `src/model/graph.ts`: two disposable cells and `orchestrator-auth` tools/reporter.
- `src/ui/App.tsx`: compact HP paper/slate/indigo controls, explicit target and
  effects, separate status/access evidence; phone reflow; shared command map.
- `auth.browser-check.mjs`: actual browser/tool-surface checks, with no provider IO.

```sh
# From experiments/
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run \
  ../060-authentication-flows/src/model/auth.test.ts \
  ../060-authentication-flows/src/model/graph.test.ts
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
```

The real-browser runner is:

```js
await (await import('/auth/auth.browser-check.mjs')).runAuthBrowserChecks()
```

Validation recorded on 19 October: shared TypeScript checking and 15 pure/graph
tests passed; 41 real-browser checks passed across all 12 fixture combinations
and fault cases. The clean final browser run had no console errors or warnings. CLI `--help`
verified Codex auth configure and Claude profile create flags without loading
credentials. Separate checks exercised keyboard start/cancel and command map,
component and graph HMR retaining a frozen attempt, and phone layouts with
`clientWidth = scrollWidth` at 360, 390 and 414 CSS pixels, including remote Claude
reuse, an observed receipt and the study popup. Desktop was checked at 1440 CSS
pixels. A rapid viewport/reset stress loop once produced a Solid development
`HOT_SCOPE_TIME` warning (8.1 ms in a 1000 ms window); the diagnostic guide was
read, and the clean complete interaction run did not reproduce it. The host
coordinates the final combined build while other Round A studies are edited
concurrently. No live provider login, renewal, cancellation or
model-access validation was performed; inference spend was USD 0.

Potential reuse after review: an owner/location strip and a receipt that separates
native evidence from access validation. These are local experiments, not upstream
components. Native configuration editing remains outside this slice.
