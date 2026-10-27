import { describe, expect, it } from "vitest";
import { conversationKey, resolveLaunchContext, resolveTurnSettings } from "../src/index.ts";

describe("scope and temporary intent", () => {
  it("uses the action's context and makes explicit overrides distinguishable", () => {
    expect(resolveLaunchContext({ hostId: "b", cwd: "/project" }, { cwd: "/worktree" })).toEqual({
      host: { value: "b", basis: "context" },
      cwd: { value: "/worktree", basis: "override" },
      projectId: undefined,
    });
  });
  it("carries a turn choice forward without changing saved defaults or a sibling", () => {
    const defaults = { model: "default", effort: "low" };
    const sibling = resolveTurnSettings(defaults, {});
    const selected = resolveTurnSettings(defaults, {}, { model: "temporary" });
    expect(resolveTurnSettings(defaults, selected.working).effective.model).toBe("temporary");
    expect(defaults.model).toBe("default");
    expect(sibling.effective.model).toBe("default");
    expect(
      resolveTurnSettings(defaults, selected.working, { model: undefined }).effective.model,
    ).toBe("default");
  });
  it("does not collapse identical native IDs from distinct profile/source scopes", () => {
    const base = { provider: "codex" as const, hostId: "host", conversationId: "id" };
    expect(conversationKey({ ...base, profileId: "a" })).not.toBe(
      conversationKey({ ...base, profileId: "b" }),
    );
    expect(conversationKey({ ...base, sourceId: "one" })).not.toBe(
      conversationKey({ ...base, sourceId: "two" }),
    );
  });
});
