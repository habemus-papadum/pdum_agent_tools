import "./styles.css";
import "./model/graph.ts";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { appScope, refresh } from "./model/store.ts";
import { App } from "./ui/App.tsx";

export const page: SitePage = {
  title: "Agent tools · Orchestrator",
  App,
  toolsNs: appScope.name,
  activate: () => {
    void refresh.run({});
  },
};
