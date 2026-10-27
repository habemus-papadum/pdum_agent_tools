import {
  type ProviderId,
  resolveLaunchContext,
  resolveTurnSettings,
} from "@habemus-papadum/agent-core";
import { type OutputPart, Prompt, rehydrate, snapshot, Text } from "@habemus-papadum/aiui-prompts";

export interface PromptContext {
  hostId: string;
  cwd: string;
}

export interface PromptDraft {
  text: string;
  provider: ProviderId;
  model: string;
  workspaceOverride: string;
}

/** Resolve working values without mutating any saved profile or global default. */
export function resolvePromptContext(context: PromptContext, draft: PromptDraft) {
  const resolved = resolveLaunchContext(
    context,
    draft.workspaceOverride.trim() ? { cwd: draft.workspaceOverride.trim() } : {},
  );
  const settings = resolveTurnSettings({}, draft.model.trim() ? { model: draft.model.trim() } : {});
  return {
    hostId: resolved.host.value,
    cwd: resolved.cwd.value,
    cwdSource: resolved.cwd.basis === "override" ? "working override" : "coordinator workspace",
    model: settings.effective.model ?? null,
    modelSource: draft.model.trim() ? "working override" : "provider default",
    provider: draft.provider,
  } as const;
}

/** Fresh observation metadata does not change the working target's semantic value. */
export function samePromptTarget(
  left: ReturnType<typeof resolvePromptContext> | null,
  right: ReturnType<typeof resolvePromptContext> | null,
) {
  if (left === null || right === null) return left === right;
  return (
    left.hostId === right.hostId &&
    left.cwd === right.cwd &&
    left.cwdSource === right.cwdSource &&
    left.model === right.model &&
    left.modelSource === right.modelSource &&
    left.provider === right.provider
  );
}

/** Text-only preparation refuses richer parts rather than silently dropping them. */
export function lowerTextParts(parts: readonly OutputPart[], provider: ProviderId) {
  if (parts.some((part) => part.type !== "text")) {
    throw new Error("This preparation surface supports text only.");
  }
  const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (provider === "claude") {
    return { message: { role: "user" as const, content: [{ type: "text" as const, text }] } };
  }
  return { input: [{ type: "text" as const, text }] };
}

/** Freeze a semantic record and delivery preview. This function never sends a request. */
export function preparePrompt(draft: PromptDraft, context: PromptContext) {
  if (!draft.text.trim()) throw new Error("Enter some text before preparing a prompt.");
  const target = resolvePromptContext(context, draft);
  const record = snapshot(
    Prompt({ children: Text({ value: draft.text, origin: { kind: "composer-text" } }) }),
    { context: { target: { hostId: target.hostId, cwd: target.cwd, provider: target.provider } } },
  );
  const rendered = rehydrate(record);
  return {
    record,
    rendered,
    target,
    nativeInput: lowerTextParts(rendered.parts, draft.provider),
    state: "prepared-not-sent" as const,
  };
}

export type PreparedPrompt = ReturnType<typeof preparePrompt>;
