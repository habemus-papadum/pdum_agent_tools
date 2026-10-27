import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { resolvePromptContext, samePromptTarget } from "./prompt.ts";
import {
  appScope,
  draft,
  modelOverride,
  observation,
  prepared,
  provider,
  workspaceOverride,
} from "./store.ts";

export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /** Current coordinator observation, retaining last-known facts after connection loss. */
    connection: cell(
      () => observation.get(),
      (value) => value,
      { scope: appScope },
    ),
    /** Working target values resolved from the host context and explicit overrides. */
    target: cell(
      () => ({
        hostId: observation.get().status?.hostId ?? null,
        cwd: observation.get().status?.workspaceDirectory ?? null,
        provider: provider.get(),
        model: modelOverride.get(),
        workspaceOverride: workspaceOverride.get(),
      }),
      (value) =>
        value.hostId !== null && value.cwd !== null
          ? resolvePromptContext({ hostId: value.hostId, cwd: value.cwd }, { ...value, text: "" })
          : null,
      { scope: appScope, equals: samePromptTarget },
    ),
    /** The last explicitly prepared snapshot; draft changes never mutate its contents. */
    preview: cell(
      () => ({
        value: prepared.get(),
        text: draft.get(),
        provider: provider.get(),
        model: modelOverride.get(),
        workspaceOverride: workspaceOverride.get(),
        hostId: observation.get().status?.hostId ?? null,
        cwd: observation.get().status?.workspaceDirectory ?? null,
      }),
      (value) => {
        const text = value.value?.rendered.parts
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        const target =
          value.hostId !== null && value.cwd !== null
            ? resolvePromptContext(
                { hostId: value.hostId, cwd: value.cwd },
                {
                  text: value.text,
                  provider: value.provider,
                  model: value.model,
                  workspaceOverride: value.workspaceOverride,
                },
              )
            : null;
        return {
          value: value.value,
          current: text === value.text && samePromptTarget(value.value?.target ?? null, target),
        };
      },
      {
        scope: appScope,
        equals: (previous, next) =>
          previous.value === next.value && previous.current === next.current,
      },
    ),
  }),
  import.meta.hot,
);

export type AppGraph = ReturnType<typeof graph>;
registerStandardTools(agentToolkit(appScope.name));
if (import.meta.hot) import.meta.hot.accept();
