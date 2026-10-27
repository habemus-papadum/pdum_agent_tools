import type {SitePage} from '@habemus-papadum/aiui-viz';
import {App} from './ui/App';
import {appScope} from './model/store';
import '../style.css';
/** Mountable page; this fixture has no continuous work or live resources to park. */
export const page: SitePage = {title: 'Profile authentication', App, toolsNs: appScope.name};
