import "@habemus-papadum/aiui-design/site.css";
import { PageBoundary, type SitePage } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
// This direct, non-accepted dependency keeps durable wiring edits on the full-reload path.
import { appScope } from "./model/store.ts";
import { page } from "./page.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Application mount is missing");
root.dataset.appScope = appScope.name;
const mountTarget = root;
let dispose: (() => void) | undefined;
let mountedPage: SitePage | undefined;

/** Replace disposable view ownership while leaving store/graph owners alive. */
function mount(next: SitePage) {
  mountedPage?.deactivate?.();
  dispose?.();
  mountedPage = next;
  document.title = next.title;
  next.activate?.();
  const View = next.App;
  dispose = render(
    () => (
      <PageBoundary name={next.title}>
        <View />
      </PageBoundary>
    ),
    mountTarget,
  );
}

mount(page);
if (import.meta.hot) {
  import.meta.hot.accept("./page.tsx", (next) => {
    if (next) mount(next.page);
  });
  import.meta.hot.dispose(() => {
    mountedPage?.deactivate?.();
    dispose?.();
  });
}
