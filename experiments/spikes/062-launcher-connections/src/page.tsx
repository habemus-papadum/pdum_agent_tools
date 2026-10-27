import type {SitePage} from "@habemus-papadum/aiui-viz";
import {App} from "./ui/App";
import {appScope} from "./model/store";
import "../style.css";
export const page:SitePage={title:"Launcher connections",App,toolsNs:appScope.name};
