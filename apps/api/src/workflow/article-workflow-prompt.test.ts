import { describe, expect, it } from "vitest";
import { buildArticleWorkflowLayoutSystemPrompt } from "./article-workflow-prompt.js";

describe("article workflow layout prompt", () => {
  it("auto 主题不注入风格段，保持现状约束", () => {
    const prompt = buildArticleWorkflowLayoutSystemPrompt();
    expect(prompt).toContain("You are an expert WeChat official account article layout assistant.");
    expect(prompt).not.toContain("Visual style theme");
    // 默认参数等同 auto
    expect(buildArticleWorkflowLayoutSystemPrompt({ theme: "auto" })).toBe(prompt);
  });

  it("非 auto 主题注入风格段与主题色值", () => {
    const prompt = buildArticleWorkflowLayoutSystemPrompt({ theme: "minimal" });
    expect(prompt).toContain("Visual style theme: 极简");
    expect(prompt).toContain("#1d1d1f");
    // 现状约束仍在
    expect(prompt).toContain("The ONLY tags you may output are:");
  });

  it("themeColor 覆盖主题默认主色", () => {
    const prompt = buildArticleWorkflowLayoutSystemPrompt({ theme: "minimal", themeColor: "#123456" });
    expect(prompt).toContain("primary color: #123456");
    expect(prompt).not.toContain("primary color: #1d1d1f");
  });
});
