/** Pure simulation. No IO, credentials, clock, login URLs or provider calls. */
export type Provider = 'codex' | 'claude';
export type Host = 'local' | 'remote';
export type Strategy = 'api-key' | 'reuse-login' | 'native';
export type Scenario = 'success' | 'expired' | 'failure' | 'connection-lost';
export type Phase = 'idle' | 'waiting' | 'returned' | 'observed' | 'validated' | 'cancelled' | 'expired' | 'failed' | 'unknown';
export type Evidence = 'unchecked' | 'configuration observed' | 'native login reported' | 'unavailable' | 'unknown';
export type Access = 'not-tested' | 'passed' | 'denied';
export interface Selection { provider: Provider; host: Host; strategy: Strategy; apiKeyEnv: string; deviceAuth: boolean; }
export interface ProfileFixture { id: string; provider: Provider; host: Host; strategy: Strategy; label: string; hostLabel: string; owner: string; path: string; source: string; workspace: string; }
export const fixtures: readonly ProfileFixture[] = (['codex', 'claude'] as const).flatMap(provider =>
  (['local', 'remote'] as const).flatMap(host => (['api-key', 'reuse-login', 'native'] as const).map(strategy => {
    const root = host === 'local' ? '/mock/operator' : '/srv/mock/operator';
    const label = `${provider}-${strategy === 'native' ? 'account' : strategy === 'api-key' ? 'api' : 'borrowed'}`;
    return { id: `${host}/${label}`, provider, host, strategy, label, hostLabel: host === 'local' ? 'atlas.local' : 'workbench.remote', owner: 'operator',
      path: `${root}/profiles/${label}`, source: `${root}/existing/${provider}`, workspace: `${root}/workspace` };
  })));
export const initialSelection: Selection = {provider: 'codex', host: 'local', strategy: 'native', apiKeyEnv: 'OPENAI_API_KEY', deviceAuth: false};
export function profileFor(selection: Selection): ProfileFixture {
  const result = fixtures.find(p => p.provider === selection.provider && p.host === selection.host && p.strategy === selection.strategy);
  if (!result) throw new Error('Select an explicit fixture provider, host and strategy');
  return result;
}
export function validReference(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export interface OperationPreview {
  selection: Selection; profile: ProfileFixture; valid: boolean; error: string | null;
  owner: string; credentialSource: string; result: string; browser: string; refresh: string;
  setup: string; setupMeaning: string; command: string; operation: string; status: string;
  fields: string[]; caveat: string; remoteProposal: boolean;
}
/** Commands reflect the launchers' mounted CLI as inspected on 2026-10-19. */
export function operationPreview(selection: Selection): OperationPreview {
  const profile = profileFor(selection), isCodex = selection.provider === 'codex';
  const cli = `uv run pdum-${selection.provider} --profile-dir ${quote(profile.path)}`;
  const valid = selection.strategy !== 'api-key' || validReference(selection.apiKeyEnv);
  const status = `${cli} auth status`;
  let setup = '', setupMeaning = '', command = status, operation = '', credentialSource = '', result = '', browser = 'No browser interaction', refresh = '', caveat = '';
  let fields: string[] = [];
  if (selection.strategy === 'api-key') {
    const reference = valid ? selection.apiKeyEnv : 'INVALID_ENVIRONMENT_REFERENCE';
    if (isCodex) {
      setup = `${cli} auth configure --no-interview --method api-key --env ${reference}`;
      setupMeaning = 'Explicit auth edit on an existing Codex home. Only the variable name is saved.';
      operation = 'AuthSpec("api-key", api_key_env=…) → ProfileEdit(import_assets=False) → prepare_profile_edit → save_profile_edit';
      fields = ['config.toml: model_providers.<owned>.env_key', '.pdum/launcher.toml: environment.inherit_keys'];
      result = `${profile.path}/config.toml + .pdum/launcher.toml hold the reference; the child inherits its value at launch.`;
    } else {
      setup = `${cli} profile create --workspace ${quote(profile.workspace)} --auth api-key --api-key-env ${reference} --no-interview`;
      setupMeaning = 'Creation example only: target must not exist. This fixture represents an already-created profile; existing-profile auth editing is not exposed by the CLI.';
      operation = 'create_profile(…, auth=AuthSpec("api-key", api_key_env=…)); build_environment(profile) resolves the host variable';
      fields = ['profile.json: authentication.method = api-key', 'profile.json: authentication.api_key_env'];
      result = `${profile.path}/profile.json holds the reference; child ANTHROPIC_API_KEY receives the value at launch.`;
    }
    credentialSource = `${profile.hostLabel} · operator environment · ${reference}`;
    refresh = 'External credential workflow owns key rotation. No interactive API-key login action.';
    caveat = 'Reference presence and native status do not prove that a model request will succeed.';
  } else if (selection.strategy === 'reuse-login') {
    if (isCodex) {
      setup = `${cli} profile create --from-codex-home ${quote(profile.source)} --copy-auth --auth chatgpt --no-interview`;
      setupMeaning = 'Creation provenance only: target must not exist. --copy-auth is a snapshot during non-clean creation, not an existing-profile reuse toggle.';
      operation = 'ProfileEdit(copy_auth=True, auth=AuthSpec("chatgpt")) → prepare_profile_edit → save_profile_edit';
      fields = ['Creation option: ProfileEdit.copy_auth', 'Target auth.json: copied file, never a link', 'Native config.toml remains authoritative'];
      credentialSource = `${profile.hostLabel} · ${profile.source}/auth.json (file-backed snapshot)`;
      result = `${profile.path}/auth.json holds a copy; the source is never written back.`;
      refresh = 'Native Codex owns refresh of the target copy. Independent refresh owners can invalidate either session.';
      caveat = 'There is no --auth reuse-login in pdum-codex. Dedicated profile login is the cleaner long-lived workflow.';
    } else {
      setup = `${cli} profile create --workspace ${quote(profile.workspace)} --auth reuse-login --source-directory ${quote(profile.source)} --no-interview`;
      setupMeaning = 'Creation provenance only: target must not exist. The fixture selects an explicit file-backed source on the same host.';
      operation = 'create_profile(…, auth=AuthSpec("reuse-login", source_directory=…)); build_environment(profile) borrows the access token';
      fields = ['profile.json: authentication.method = reuse-login', 'profile.json: authentication.source_directory', 'Child environment: CLAUDE_CODE_OAUTH_TOKEN'];
      credentialSource = `${profile.hostLabel} · ${profile.source}/.credentials.json`;
      result = 'Token is borrowed into the owned child environment. Source credentials are neither copied nor modified.';
      refresh = 'Borrowed-token refresh is not managed. Renew the source through its native login, then explicitly try again.';
      caveat = 'Without a source-directory, macOS reuse reads the ordinary Claude Keychain entry, otherwise the ordinary credential file. Custom Keychain services are not inferred.';
    }
  } else {
    if (isCodex) {
      setup = `${cli} auth configure --no-interview --method chatgpt`;
      setupMeaning = 'Explicit configuration edit first; a failed login does not roll back this saved configuration.';
      command = `${cli} auth login${selection.deviceAuth ? ' --device-auth' : ''}`;
      operation = 'login_auth(directory, device_auth=…) → login_chatgpt → native codex login';
      fields = ['config.toml: model_provider = openai', 'config.toml: cli_auth_credentials_store = file', 'Target auth.json: native credential store'];
      browser = selection.deviceAuth ? 'Operator-chosen browser for the native device flow; initiating process stays on the selected host.' : `Native Codex opens its browser flow from ${profile.hostLabel}.`;
      result = `${profile.path}/auth.json on ${profile.hostLabel}; CODEX_HOME is this profile.`;
      refresh = 'Native Codex owns token refresh. No application-owned refresh endpoint is proposed here.';
      caveat = 'A custom model_providers.openai table can conflict with ChatGPT setup. Remote handoff/cancellation still need live qualification.';
    } else {
      setup = `${cli} profile create --workspace ${quote(profile.workspace)} --auth native --no-interview`;
      setupMeaning = 'Creation provenance only: target must not exist. The selected fixture already uses native authentication.';
      command = `${cli} auth login`;
      operation = 'login_auth(profile) → claude --setting-sources user,project auth login --claudeai';
      fields = ['profile.json: authentication.method = native', `CLAUDE_CONFIG_DIR = ${profile.path}/claude`, `ANTHROPIC_CONFIG_DIR = ${profile.path}/anthropic`];
      browser = `Browser/code interaction belongs to Claude’s native host-terminal flow on ${profile.hostLabel}.`;
      result = `Native credential storage associated with ${profile.path}/claude on ${profile.hostLabel}; macOS may use its directory-associated Keychain.`;
      refresh = 'Dedicated login and a subsequent SDK turn passed earlier qualification; credential refresh remains unqualified.';
      caveat = 'This native flow selects a Claude account (--claudeai). Console keyless login and custom Keychain discovery are not exposed.';
    }
    credentialSource = `New dedicated native login for ${profile.label} on ${profile.hostLabel}`;
  }
  return { selection: {...selection}, profile, valid, error: valid ? null : 'Enter an environment variable name, never a key value.', owner: `${profile.owner} on ${profile.hostLabel}`, credentialSource, result, browser, refresh,
    setup, setupMeaning, command, operation, status, fields, caveat, remoteProposal: selection.host === 'remote' };
}
export interface Receipt { phase: Phase; attempt: number; plan: OperationPreview | null; scenario: Scenario; presence: Evidence; access: Access; events: string[]; }
export const initialReceipt = (): Receipt => ({phase: 'idle', attempt: 0, plan: null, scenario: 'success', presence: 'unchecked', access: 'not-tested', events: []});
export function active(receipt: Receipt) { return receipt.phase === 'waiting' || receipt.phase === 'returned'; }
export function begin(receipt: Receipt, selection: Selection, scenario: Scenario): Receipt {
  if (active(receipt)) throw new Error('Finish or cancel the current attempt before starting another');
  const plan = operationPreview(selection);
  if (!plan.valid) throw new Error(plan.error!);
  return {phase: 'waiting', attempt: receipt.attempt + 1, plan, scenario, presence: 'unchecked', access: 'not-tested', events: [
    `SIMULATION ${receipt.attempt + 1} · frozen target ${plan.profile.id}`,
    selection.strategy === 'native' ? 'Simulated native login started; operator interaction is pending.' : 'Simulated status inspection started; no login process is required.',
  ]};
}
function record(receipt: Receipt, patch: Partial<Receipt>, message: string): Receipt { return {...receipt, ...patch, events: [...receipt.events, message]}; }
export function advance(receipt: Receipt): Receipt {
  if (!receipt.plan || !active(receipt)) return receipt;
  if (receipt.phase === 'waiting') {
    if (receipt.scenario === 'connection-lost') return record(receipt, {phase: 'unknown', presence: 'unknown'}, 'Connection lost: the host outcome is unknown. No automatic retry or claim that the host stopped.');
    if (receipt.scenario === 'expired') return record(receipt, {phase: 'expired'}, receipt.plan.selection.strategy === 'native' ? 'Synthetic login challenge expired. A fresh explicit attempt is required.' : 'Synthetic credential expiry. Renew at the credential owner, then explicitly recheck.');
    if (receipt.scenario === 'failure') return record(receipt, {phase: 'failed', presence: 'unavailable'}, 'Synthetic failure: native login failed or the selected credential reference was unavailable. No fallback identity was selected.');
    return record(receipt, {phase: 'returned'}, receipt.plan.selection.strategy === 'native' ? 'Synthetic native login returned exit code 0. Model access has not been tested.' : 'Synthetic status command returned. Inspect the provider-specific evidence next.');
  }
  return record(receipt, {phase: 'observed', presence: receipt.plan.selection.provider === 'codex' ? 'configuration observed' : 'native login reported'}, receipt.plan.selection.provider === 'codex'
    ? 'Codex fixture: selected configuration/auth-file presence observed; authenticated = "not checked".'
    : 'Claude fixture: native auth status reports logged_in = true; inference and token refresh remain unproved.');
}
export function cancel(receipt: Receipt): Receipt {
  if (!active(receipt) || !receipt.plan) return receipt;
  if (receipt.plan.selection.host === 'remote') return record(receipt, {phase: 'unknown', presence: 'unknown'}, 'Stopped watching the remote attempt. Host login cancellation is unconfirmed; inspect the host before another attempt.');
  return record(receipt, {phase: 'cancelled'}, 'Synthetic local cancellation: the owned login/status process was stopped. Saved settings are not rolled back.');
}
export function validateAccess(receipt: Receipt, outcome: 'passed' | 'denied'): Receipt {
  if (receipt.phase !== 'observed') throw new Error('Observe native status before the separate model-access simulation');
  return record(receipt, {phase: 'validated', access: outcome}, outcome === 'passed' ? 'Synthetic model request passed. This is fixture evidence only; no model was called.' : 'Synthetic model request denied despite credential presence. Check account/model entitlement at the provider.');
}
export function phaseLabel(receipt: Receipt): string {
  return ({idle: 'Choose a profile and strategy', waiting: receipt.plan?.selection.strategy === 'native' ? 'Waiting for native login' : 'Inspecting authentication', returned: 'Native result returned', observed: 'Status observed · access untested', validated: receipt.access === 'passed' ? 'Simulated access passed' : 'Simulated access denied', cancelled: 'Cancelled locally', expired: 'Expired · explicit retry needed', failed: 'Failed · inspect the cause', unknown: 'Host outcome unknown'})[receipt.phase];
}
