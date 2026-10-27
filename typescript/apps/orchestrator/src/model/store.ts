import type { ProviderId } from "@habemus-papadum/agent-core";
import { action, control, scope } from "@habemus-papadum/aiui-viz";
import { ConnectionOwner, initialObservation } from "./connection.ts";
import { type PreparedPrompt, preparePrompt } from "./prompt.ts";

export const appScope = scope("orchestrator");
export const connectionOwner = appScope.durable("connection-owner", () => new ConnectionOwner());
export const observation = appScope.durableSignal("observation", initialObservation);

/** Destination whose native text input is previewed. Preparing does not connect to a provider. */
export const provider = control<ProviderId>({
  scope: appScope,
  value: "codex",
  options: ["codex", "claude", "hp"],
});

/** Text to prepare. Its whitespace is retained in the structured prompt. */
export const draft = control({ scope: appScope, value: "" });

/** Temporary working model override. Blank leaves the provider default unchanged. */
export const modelOverride = control({ scope: appScope, value: "" });

/** Temporary working-directory override. Blank uses the selected coordinator's workspace. */
export const workspaceOverride = control({ scope: appScope, value: "" });

export const prepared = appScope.durableSignal<PreparedPrompt | null>("prepared-prompt", null);
export const preparationError = appScope.durableSignal<string | null>("preparation-error", null);

/** Read this coordinator's current status and run inventory; never launch an agent.
 * @usage Use after a connection error or when the host inventory may have changed.
 */
export const refresh = action({
  scope: appScope,
  name: "refresh",
  run: () => connectionOwner.refresh(observation.set),
});

/** Prepare immutable content and a provider input preview, without submitting a model request.
 * @usage Set draft/provider and optional working overrides first. The returned state is prepared-not-sent.
 */
export const prepare = action({
  scope: appScope,
  name: "prepare",
  run: () => {
    const status = observation.get().status;
    if (!status) {
      const error = "Connect to a coordinator before preparing a targeted prompt.";
      preparationError.set(error);
      return { state: "unavailable", error };
    }
    try {
      const result = preparePrompt(
        {
          text: draft.get(),
          provider: provider.get(),
          model: modelOverride.get(),
          workspaceOverride: workspaceOverride.get(),
        },
        { hostId: status.hostId, cwd: status.workspaceDirectory },
      );
      prepared.set(result);
      preparationError.set(null);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      preparationError.set(message);
      return { state: "invalid", error: message };
    }
  },
});

/** Remove working model/directory overrides; no saved configuration is written. */
export const resetOverrides = action({
  scope: appScope,
  name: "reset-overrides",
  run: () => ({ model: modelOverride.set(""), workspace: workspaceOverride.set("") }),
});
