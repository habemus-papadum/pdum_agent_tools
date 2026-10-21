import type {DemoCard} from '@habemus-papadum/aiui-viz';
import {initialSelection, operationPreview} from './model/auth';
/** Pure preview: no store, cell graph, credential inspection or tool registration. */
const Preview = () => {
  const plan = operationPreview(initialSelection);
  return <div style={{background: 'var(--plate)', color: 'var(--plate-ink)', border: '1px solid var(--hairline)', padding: '18px'}}>
    <small>SIMULATION · CODEX / CLAUDE</small><p>this browser → {plan.profile.hostLabel} → native profile</p>
    <small>Native status → separate model-access check</small>
  </div>;
};
export const card: DemoCard = {blurb: 'Make provider, profile, host and credential ownership explicit before a simulated login.', Preview};
