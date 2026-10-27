import '@habemus-papadum/aiui-design/site.css';
import {PageBoundary} from '@habemus-papadum/aiui-viz';
import {render} from '@solidjs/web';
import {mountDock} from '../../055-orchestrator-mock-lab/shared/dock';
import {page} from './page';
render(() => <PageBoundary name={page.title}><page.App/></PageBoundary>, document.getElementById('root')!);
mountDock();
