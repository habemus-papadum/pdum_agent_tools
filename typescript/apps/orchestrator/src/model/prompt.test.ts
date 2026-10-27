import { Image, Prompt, rehydrate, snapshot } from "@habemus-papadum/aiui-prompts";
import { describe, expect, it } from "vitest";
import {
  lowerTextParts,
  type PromptDraft,
  preparePrompt,
  resolvePromptContext,
  samePromptTarget,
} from "./prompt.ts";

const context = { hostId: "host-a", cwd: "/projects/current" };
const draft: PromptDraft = {
  text: "  Keep 4.500 eV\n\nand λ.  ",
  provider: "codex",
  model: "",
  workspaceOverride: "",
};

describe("structured text preparation", () => {
  it("target equality ignores object identity but preserves provider and override provenance", () => {
    const resolved = resolvePromptContext(context, draft);
    expect(samePromptTarget(resolved, { ...resolved })).toBe(true);
    expect(samePromptTarget(resolved, { ...resolved, provider: "claude" })).toBe(false);
    expect(samePromptTarget(resolved, { ...resolved, cwdSource: "working override" })).toBe(false);
    expect(samePromptTarget(resolved, null)).toBe(false);
  });
  it("retains exact text through the actual prompt compiler and each destination preview", () => {
    for (const provider of ["codex", "claude", "hp"] as const) {
      const prepared = preparePrompt({ ...draft, provider }, context);
      expect(prepared.record.kind).toBe("aiui.prompt");
      expect(prepared.rendered.parts).toEqual([
        expect.objectContaining({ type: "text", text: draft.text }),
      ]);
      expect(JSON.stringify(prepared.nativeInput)).toContain(JSON.stringify(draft.text));
      expect(prepared.state).toBe("prepared-not-sent");
    }
  });

  it("uses current context unless explicitly overridden and never writes saved defaults", () => {
    const working = { ...draft, model: "working-model", workspaceOverride: "/selected/worktree" };
    expect(resolvePromptContext(context, draft)).toMatchObject({ cwd: context.cwd, model: null });
    const first = preparePrompt(working, context);
    const next = preparePrompt({ ...working, text: "Next turn" }, context);
    expect(next.target).toEqual(first.target);
    const unrelated = preparePrompt(
      { ...draft, provider: "hp", text: "Unrelated preparation" },
      context,
    );
    expect(unrelated.target).toMatchObject({ cwd: context.cwd, model: null });
    expect(working.model).toBe("working-model");
  });

  it("a prepared snapshot stays unchanged after subsequent draft or target changes", () => {
    const mutable = { ...draft };
    const prepared = preparePrompt(mutable, context);
    const original = JSON.stringify(prepared);
    mutable.text = "Changed later";
    mutable.model = "different-model";
    preparePrompt(mutable, context);
    expect(JSON.stringify(prepared)).toBe(original);
    expect(() => preparePrompt({ ...draft, text: " \n " }, context)).toThrow("Enter some text");
  });

  it("does not silently reduce an image to empty text", () => {
    const record = snapshot(
      Prompt({ children: Image({ asset: { id: "example-image", mimeType: "image/png" } }) }),
    );
    expect(() => lowerTextParts(rehydrate(record).parts, "hp")).toThrow("text only");
  });
});
