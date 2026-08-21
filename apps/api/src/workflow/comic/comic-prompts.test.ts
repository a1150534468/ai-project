import { describe, expect, it } from "vitest";
import {
  buildComicBiblePromptContext,
  buildComicScriptPrompt,
  containsComicForbiddenTerms,
} from "./comic-prompts.js";

describe("comic prompts", () => {
  it("builds bible context from project style, episode summary, and entries", () => {
    const context = buildComicBiblePromptContext({
      project: {
        title: "霓虹侦探社",
        logline: "失忆侦探追查城市幻影",
        style: "赛博都市、硬光边缘、电影感构图",
      },
      episode: {
        title: "雨夜委托",
        summary: "主角在雨夜收到第一份委托",
        targetDurationSec: 90,
      },
      bibleEntries: [
        { category: "character", title: "林澈", content: "冷静但害怕霓虹灯" },
        { category: "scene", title: "旧港区", content: "潮湿、拥挤、广告牌密集" },
      ],
    });

    expect(context).toContain("霓虹侦探社");
    expect(context).toContain("赛博都市");
    expect(context).toContain("雨夜委托");
    expect(context).toContain("90 秒");
    expect(context).toContain("林澈");
    expect(context).toContain("旧港区");
    expect(containsComicForbiddenTerms(context)).toBe(false);
  });

  it("builds script prompt with strict stage boundaries and no forbidden white-model terms", () => {
    const prompt = buildComicScriptPrompt({
      projectTitle: "霓虹侦探社",
      bibleContext: "角色：林澈\n场景：旧港区",
      userPrompt: "做一集强冲突开场",
      targetDurationSec: 120,
    });

    expect(prompt).toContain("霓虹侦探社");
    expect(prompt).toContain("120 秒");
    expect(prompt).toContain("角色：林澈");
    expect(prompt).toContain("做一集强冲突开场");
    expect(containsComicForbiddenTerms(prompt)).toBe(false);
  });
});
