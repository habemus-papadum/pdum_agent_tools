import '@habemus-papadum/aiui-design/site.css';
import {PageBoundary} from '@habemus-papadum/aiui-viz';
import {render} from '@solidjs/web';
import {App} from './ui/App';
import {mountDock} from '../../055-orchestrator-mock-lab/shared/dock';
import '../style.css';
import './mock-api';
render(()=> <PageBoundary name="Orchestrator session"><App/></PageBoundary>,document.getElementById('root')!);
mountDock();
