import type {DemoCard} from '@habemus-papadum/aiui-viz';
/** Pure preview of the task, without registering tools or reading credentials. */
const Preview = () => <div style={{background:'var(--plate)',color:'var(--plate-ink)',padding:'18px'}}><small>PROFILE AUTHENTICATION · MOCK</small><p>Machines → profiles → agents</p><small>Choose a profile. Sign in. Return to your work.</small></div>;
export const card:DemoCard={blurb:'Browse machines and profiles, then try local, remote and exploratory cloud sign-in journeys.',Preview};
