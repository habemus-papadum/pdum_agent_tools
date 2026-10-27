import "@habemus-papadum/aiui-design/site.css";
import {PageBoundary} from "@habemus-papadum/aiui-viz";
import {render} from "@solidjs/web";
import {page} from "./page";
render(()=><PageBoundary name="Launcher connections"><page.App/></PageBoundary>,document.getElementById("root")!);
