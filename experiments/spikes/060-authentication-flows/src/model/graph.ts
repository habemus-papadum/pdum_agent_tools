import {agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {operationPreview, phaseLabel} from './auth';
import {apiKeyEnv, appScope, deviceAuth, host, provider, receipt, strategy} from './store';
export const graph = hotCellGraph(appScope.name, () => {
  /** Read-only mapping from all transient choices into existing launcher operations and native fields. */
  const preview = cell(() => ({provider: provider.get(), host: host.get(), strategy: strategy.get(), apiKeyEnv: apiKeyEnv.get(), deviceAuth: deviceAuth.get()}), operationPreview, {scope: appScope});
  /** Receipt projection preserves the frozen attempt target even if the next draft selection changes. */
  const progress = cell(() => receipt.get(), current => ({...current, label: phaseLabel(current)}), {scope: appScope});
  return {preview, progress};
}, import.meta.hot);
if (import.meta.hot) import.meta.hot.accept();
export const kit = agentToolkit(appScope.name, {brief: 'Authentication interaction study. Every host, profile, status, login and access result is synthetic. Use set and actions to choose provider/host/strategy, start, advance, cancel and validate-access. No credentials are read, no login/browser/worker starts, no profile is written and no provider request runs. API input is a variable name only. Remote handoff and refresh remain unqualified.'});
registerStandardTools(kit);
kit.registerReporter('authentication', () => ({simulation: true, preview: graph().preview.latest(), receipt: receipt.get()}));
