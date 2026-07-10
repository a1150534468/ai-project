import { describe, expect, it } from "vitest";
import { buildNovelUserPrompt } from "./novel-prompts.js";

describe("novel prompts", () => {
  it("includes requested character count for character planning", () => {
    const prompt = buildNovelUserPrompt({
      targetKind: "chars",
      projectTitle: "寒泉烬",
      targetCount: 8,
    });

    expect(prompt).toContain("数量要求：请生成 8 个角色。");
  });

  it("includes requested volume count for volume planning", () => {
    const prompt = buildNovelUserPrompt({
      targetKind: "volumes",
      projectTitle: "寒泉烬",
      targetCount: 5,
    });

    expect(prompt).toContain("数量要求：请生成 5 卷。");
  });

  it("includes requested chapter count for outline planning", () => {
    const prompt = buildNovelUserPrompt({
      targetKind: "outline",
      projectTitle: "寒泉烬",
      targetCount: 18,
    });

    expect(prompt).toContain("数量要求：请生成 18 个章节。");
  });
});
