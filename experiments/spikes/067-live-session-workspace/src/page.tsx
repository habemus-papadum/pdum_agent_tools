import type {SitePage} from '@habemus-papadum/aiui-viz';
import {appScope} from './model/store';
import {App} from './ui/App';
import '../style.css';
export const page: SitePage = {title: 'Live workspace', App, toolsNs: appScope.name};
