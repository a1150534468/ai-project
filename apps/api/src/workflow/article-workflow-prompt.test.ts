import { describe, expect, it } from "vitest";
import { buildArticleWorkflowLayoutSystemPrompt } from "./article-workflow-prompt.js";

describe("article workflow layout prompt", () => {
  it("保留现状约束（AI 自由排版，无主题注入）", () => {
    const prompt = buildArticleWorkflowLayoutSystemPrompt();
    expect(prompt).toContain("You are an expert WeChat official account article layout assistant.");
    expect(prompt).toContain("The ONLY tags you may output are:");
    expect(prompt).toContain("Avoid risky layout techniques");
  });
});
