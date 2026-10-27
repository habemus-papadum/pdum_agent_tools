# Profile authentication — interaction study

**060 · revised direction, 24 October 2026 · disposable mock.** The user task is
“make this profile ready to use.” Start with machines, the profiles on each
machine, and the agents using those profiles. Seven fixed profiles across two machines
provide the starting fixtures. Choose a profile, review its
current authentication status, follow a sign-in or credential-selection flow,
and return to the profile.

The 19 October version made operation previews and simulated response handling
the main experience. Review found that difficult to understand. This revision
puts the intended application journey first. A separate commentary pane explains
the concept; study controls and unanswered engineering questions live outside the
proposed application surface. The layout and policies remain open for review.

**User review, 24 October:** the revised flow makes sense and would work well.
Keep the interaction direction; refine the visual style to match the other mocks
and make the information display denser later. Backend policies remain open.
See the [handoff to the original implementation agent](HANDOFF.md) for the review
feedback, the original disconnect and what to preserve.

## What to try

- Find a profile on a local or remote machine. Inspect the agents using it and
  its authentication status: a known fixture expiry, an expired credential, or
  an unknown expiry. A profile keeps its identity when an authentication method
  changes; it is not recreated as a different profile for each choice.
- Follow a browser sign-in journey, including the proposed experience of using
  this browser to sign a profile in on a remote host. The provider page is a
  local simulation; no external login page opens.
- Explore API-key references and existing-login reuse. Workforce Federation and
  Bedrock appear as conceptual flows whose implementation and native ownership
  still require investigation.
- With agents running, compare explicit “Continue now” and “Wait for idle” alternatives.
  These illustrate a question for review; neither establishes a safety guarantee,
  a queueing implementation, or an agreed default.
- Inspect success, expiry, failure and lost-connection outcomes through the
  separate study controls. Return to the profile and see what was observed.

No credential files, Keychain, native login, real profiles, workers or provider
APIs are touched. Credential inputs are fixture references. Counts, identities,
expiry information and outcomes are synthetic. No real expiry discovery, refresh,
remote handoff or effect on a running agent is qualified by this mock.

## Run

From `experiments/`, with the root `.dev/aiui` source link and research workspace
dependencies installed:

```sh
node spikes/055-orchestrator-mock-lab/serve.mjs
```

Open the printed URL at `/060-authentication-flows/` (also `/auth/`). The shared
host owns installation, source compilation and navigation. `Space` opens the
command map. The view uses Solid and AIUI controls, durable state, cells and
source tooling. The mock does not need a provider-connected oracle to operate.

## Configuration and operation map

Profiles and configuration remain owned by the existing launchers. The mock's
selected machine/profile, method, timing and outcome are temporary interaction
state; they do not define another durable authentication schema. Full native
profile creation/editing remains Round B, spike 063. Changing a method in the
walkthrough does not imply that every existing profile can be edited through a
currently implemented launcher operation.

The map below is implementation background for the commentary and later live
work. `P`, `S`, and `W` mean explicit profile, source and workspace paths on the
**selected host**. `uv run` commands run from the repository root. Creation
examples require an absent target and are not a recipe for recreating an existing
profile. Unsupported paths stay identified as proposals.

| UI choice | Existing operation / command | Existing field or owner |
| --- | --- | --- |
| Codex API reference | `uv run pdum-codex --profile-dir P auth configure --no-interview --method api-key --env OPENAI_API_KEY`; `AuthSpec("api-key", api_key_env=…)` through `ProfileEdit(import_assets=False)`, prepare/save | Native `config.toml` → `model_providers.<owned>.env_key`; `.pdum/launcher.toml` → `environment.inherit_keys`. Only the reference name is saved. |
| Codex existing-login reuse | Creation: `uv run pdum-codex --profile-dir P profile create --from-codex-home S --copy-auth --auth chatgpt --no-interview`; `ProfileEdit.copy_auth` | A file-backed `auth.json` snapshot in the new Codex home. Never a link or source write. There is no `--auth reuse-login` method. |
| Codex dedicated login | `uv run pdum-codex --profile-dir P auth configure --no-interview --method chatgpt`, then `… auth login [--device-auth]`; `login_auth` → `login_chatgpt` | Native `model_provider = openai`, file-backed credential store and target `auth.json`. Existing custom `model_providers.openai` can conflict. |
| Claude API reference | Creation: `uv run pdum-claude --profile-dir P profile create --workspace W --auth api-key --api-key-env ANTHROPIC_API_KEY --no-interview`; `create_profile(…, auth=AuthSpec(…))` | Existing `profile.json.authentication.api_key_env`; `build_environment` resolves on the host into child `ANTHROPIC_API_KEY`. No existing-profile auth-configure CLI is exposed. |
| Claude existing-login reuse | Creation: `… profile create --workspace W --auth reuse-login --source-directory S --no-interview`; `AuthSpec("reuse-login", source_directory=…)` | Existing `profile.json.authentication.source_directory`; token borrowed into child `CLAUDE_CODE_OAUTH_TOKEN`. No source write, copy or managed refresh. Without `S`, ordinary macOS Keychain/file fallback belongs to the launcher. |
| Claude dedicated login | Existing native fixture: `uv run pdum-claude --profile-dir P auth login`; `login_auth(profile)` invokes `claude --setting-sources user,project auth login --claudeai` | Native credential store associated with `P/claude` (`CLAUDE_CONFIG_DIR`), plus `P/anthropic` (`ANTHROPIC_CONFIG_DIR`). Native browser/code interaction stays in the host terminal flow. |
| Codex AWS workload federation | Existing `auth configure --method aws-federation --federation-settings FILE`, then `auth login`; `AuthSpec("aws-federation", federation=FederationSpec(…))` | Native `model_providers.<name>.auth` helper plus launcher-owned federation settings. AWS identity → OpenAI API token; live exchange and renewal remain unqualified. This is distinct from Workforce Federation and Bedrock. |
| Workforce Federation / Bedrock | Conceptual walkthroughs only; no new command or configuration schema | Identify the identity provider, model endpoint and native owner before implementation. Claude launcher Bedrock/federation adapters are not implemented. |
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

## Questions to carry forward

The [profile/auth component](../../../docs/plans/agent-orchestrator/components/06-profiles-auth.md)
owns these product questions, with host coordination in
[O21](../../../docs/plans/agent-orchestrator/components/21-host-coordinator.md).
The table records the trigger for investigation or an operator decision. These
answers are not required to evaluate a disposable walkthrough.

| Question | Current evidence / owner and status | Needed before |
| --- | --- | --- |
| Can a profile authenticate while agents using it are working? | Open per provider/method. Inspect credential caching, credential replacement and concurrent refresh. The mock illustrates “Continue now” / “Wait for idle”; no policy selected. | Implementing a real authenticate/reauthenticate action with active workers. |
| What does “after idle” mean when several agents or background jobs share the profile? | Open. An idle conversation can have background work (RC-01/RC-04). Decide whether to observe a quiet point, prevent new work, or use another policy; an idle badge alone is insufficient. | Offering a real deferred-auth queue or promising non-disruption. |
| When do existing agents acquire the new credentials? | Provider/method-specific: environment credentials can be captured at worker launch; native credential stores and refresh behavior differ. No claim that all existing workers switch identity. | Showing which agents are ready after a profile change or offering restart/relaunch. |
| How does local browser sign-in complete for a remote Codex or Claude profile? | Open, separately for each native flow. Qualify device/code or redirect handoff, callback destination, result observation and reconnection on the selected host. The local simulated provider page does not prove transport feasibility. | Live remote sign-in in the coordinator. |
| What can the expiry indicator actually measure? | Open per source. Distinguish access-token expiry, renewable session lifetime, API-key rotation, refresh failure and last successful observation. Unknown stays unknown; an expiring access token need not mean user action is due. | Binding badges/countdowns or alerts to real status data. |
| What does a successful sign-in establish? | Native completion/status, credential availability to a process and permission to use a model are different observations. Any real model-access probe needs an explicit operation and cost. | Calling a profile usable for launch or showing model entitlement. |
| What does Workforce Federation require here? | Open identity-provider and token-exchange design. Keep human workforce login distinct from workload federation. Codex's existing AWS workload helper is a useful owner/reference, not proof of a generic human federation path. | Adding a real federation method or changing profile configuration. |
| What does Bedrock require? | Open provider routing, AWS credential chain/SSO or role source, region and model entitlement. Claude launcher adapters are not implemented. Preserve native provider settings rather than creating a generic replacement. | Offering a working Bedrock profile/auth flow. |
| What do cancel, lost connection, retry and refresh mean? | Preserve unknown remote outcomes and separate stop-watching from confirmed host cancellation (RC-07/RC-08). Reconcile before retrying; do not assume a failed connection undid a credential change. | Implementing remote control, automatic renewal, or recovery. |

Already answered: authentication targets a profile on a machine; several agents
may use the profile. The first practical methods remain API-key references,
explicit existing-login reuse and native dedicated-profile login. Conceptual
federation/Bedrock flows keep later work visible without making it a dependency.
Routine component/layout choices are delegated. Existing configuration owners and
unknown-field preservation remain requirements, not new questions.

[RC-07](../../../docs/runtime-contracts.md#rc-07-observation-and-recovery-have-gaps)
and [RC-08](../../../docs/runtime-contracts.md#rc-08-lifetimes-are-provider-specific)
contribute acceptance checks for an unknown remote outcome and distinct provider
semantics. [RC-01](../../../docs/runtime-contracts.md#rc-01-runtime-state-is-not-task-completion)
and [RC-04](../../../docs/runtime-contracts.md#rc-04-unloading-can-kill-background-terminals)
keep “idle” separate from “no dependent work.” These runtime contracts do not
establish authentication-process behavior.

## Acceptance and evidence

The revised walkthrough should preserve the selected machine/profile through
method choice and provider handoff, show agents independently of profile auth
status, retain unknown expiry, and make its simulated provider page unmistakable.
Review the simple task first; inspect technical provenance or unanswered questions
when useful. The current checks below qualify this disposable UI only; they do not establish
provider compatibility. Earlier results are retained separately.

### Earlier version: 19 October 2026

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


### Revision: 24 October 2026

The revised UI passed 15 checks across the source-operation map, journey reducer
and AIUI graph. The real-browser runner passed 62 assertions at 1440 × 900 and
360/390/414 × 844 CSS pixels, covering all 17 profile/method combinations,
return to the profile, idle/background separation, a denied model-access check,
expiry/failure/connection loss, and frozen targets. Phone inventory and the remote
Claude sign-in popup were visually inspected. Actual UI buttons opened the remote
journey; Escape left its result unknown; Space opened the command map.

Component and graph HMR edits preserved an open remote sign-in attempt. Two Solid
identity/equality diagnostics found during the first browser pass were repaired
with stable list keys and an inventory equality gate; the clean rerun had no
console errors or warnings. TypeScript, the shared Vite build and strict MkDocs
build passed. The shared build retains its existing large-chunk and runtime
`/__aiui-design/site.css` warnings; standalone deployment is not qualified here.

Reproduce from `experiments/`:

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run ../060-authentication-flows/src/model/
```

In the served page, run
`await (await import('/auth/auth.browser-check.mjs')).runAuthBrowserChecks()`.
The state logic lives in `src/model/journey.ts`; `auth.ts` retains the earlier
source-inspected operation map, not a second interactive state machine.

Environment: Node 26.10.0, pnpm 11.9.0, source-linked AIUI checkout `e17191ff`.
No new live authentication or provider inference was performed; experiment
inference spend **USD 0**, excluding development-agent service usage. This revision
has been reviewed positively for its interaction flow; visual refinement and
running-agent, remote, expiry and cloud-auth policies remain open.
