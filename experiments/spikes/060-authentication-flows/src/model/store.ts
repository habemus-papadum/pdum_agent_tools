import {action, control, scope} from '@habemus-papadum/aiui-viz';
import {advance as nextReceipt, begin, cancel as cancelReceipt, initialReceipt, validateAccess, type Host, type Provider, type Scenario, type Selection, type Strategy} from './auth';
export const appScope = scope('orchestrator-auth');
/** Provider whose existing launcher owns the operation. Changes choose a fixture; they never edit a profile. */
export const provider = control<Provider>({scope: appScope, value: 'codex', options: ['codex', 'claude']});
/** Host that owns the selected fixture profile and credential lookup. Remote orchestration remains proposed. */
export const host = control<Host>({scope: appScope, value: 'local', options: ['local', 'remote']});
/** Select an already-configured fixture profile for this strategy. The profile workbench belongs to round B. */
export const strategy = control<Strategy>({scope: appScope, value: 'native', options: ['api-key', 'reuse-login', 'native']});
/** Environment variable NAME for the transient operation preview. Never paste an API key here. */
export const apiKeyEnv = control({scope: appScope, value: 'OPENAI_API_KEY', options: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TEAM_PROVIDER_KEY']});
/** Codex native device flow option. Claude has no equivalent launcher option in this study. */
export const deviceAuth = control({scope: appScope, value: false});
/** Synthetic outcome frozen when an attempt begins. Never represents a real upstream response. */
export const scenario = control<Scenario>({scope: appScope, value: 'success', options: ['success', 'expired', 'failure', 'connection-lost']});
/** Synthetic result for the separate model-access check; no inference request runs. */
export const accessOutcome = control<'passed'|'denied'>({scope: appScope, value: 'passed', options: ['passed', 'denied']});
export const receipt = appScope.durableSignal('receipt', initialReceipt());
export function selection(): Selection { return {provider: provider.get(), host: host.get(), strategy: strategy.get(), apiKeyEnv: apiKeyEnv.get(), deviceAuth: deviceAuth.get()}; }
/** Freeze the selected provider, profile, host and outcome, then start one simulated attempt. */
export const start = action({scope: appScope, name: 'start', group: 'authentication', run: () => receipt.set(current => begin(current, selection(), scenario.get()))});
/** Advance one synthetic response step. This never opens a browser or calls a provider. */
export const advance = action({scope: appScope, name: 'advance', group: 'authentication', run: () => receipt.set(nextReceipt)});
/** Cancel the synthetic local operation, or stop observing a remote operation without claiming the host stopped. */
export const cancel = action({scope: appScope, name: 'cancel', group: 'authentication', run: () => receipt.set(cancelReceipt)});
/** Separately simulate a model request. Credential presence alone never establishes model access. */
export const validate = action({scope: appScope, name: 'validate-access', group: 'authentication', run: () => receipt.set(current => validateAccess(current, accessOutcome.get()))});
/** Clear the local receipt and reset all synthetic choices. No host or profile is touched. */
export const reset = action({scope: appScope, name: 'reset', group: 'study', run: () => {
  provider.set('codex'); host.set('local'); strategy.set('native'); apiKeyEnv.set('OPENAI_API_KEY'); deviceAuth.set(false); scenario.set('success'); accessOutcome.set('passed');
  return receipt.set(initialReceipt());
}});
