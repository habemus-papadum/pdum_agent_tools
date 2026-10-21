import { VoiceDock } from '@habemus-papadum/aiui-dock';
import { PageBoundary } from '@habemus-papadum/aiui-viz';
import { render } from '@solidjs/web';

/** Requested local lab scaffolding. Provider connections remain operator initiated. */
export function mountDock() {
  const target = document.createElement('div');
  target.dataset.aiuiChrome = 'orchestrator-lab';
  document.body.append(target);
  const dispose = render(() => <PageBoundary name="AIUI development dock"><VoiceDock /></PageBoundary>, target);
  const cleanup = () => { dispose(); target.remove(); };
  import.meta.hot?.dispose(cleanup);
  return cleanup;
}
