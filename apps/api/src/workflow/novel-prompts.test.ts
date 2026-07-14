import { describe, expect, it } from "vitest";
import { buildNovelUserPrompt } from "./novel-prompts.js";

describe("novel prompts", () => {
  it("builds the Bible-first onboarding prompt", () => {
    const prompt = buildNovelUserPrompt({
      targetKind: "setupBible",
      projectTitle: "寒泉烬",
      genre: "东方玄幻",
      userPrompt: "整体气质冷峻",
      contextText: "梗概：废院少女追查家族旧案。",
    });
    expect(prompt).toContain("文风公约");
    expect(prompt).toContain("五维世界观");
    expect(prompt).toContain("不得改变已锁定的故事梗概");
  });

  it("builds the story-tree setup prompt", () => {
    const prompt = buildNovelUserPrompt({ targetKind: "setupPlot", projectTitle: "寒泉烬" });
    expect(prompt).toContain("主线、支线与暗线");
    expect(prompt).toContain("部卷幕章故事树");
  });
});
