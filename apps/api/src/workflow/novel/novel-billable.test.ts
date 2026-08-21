import { describe, expect, it } from "vitest";
import {
  billableCharCount,
  extractBillableText,
  formatGeneratedNovelDisplayText,
  parseRequiredGeneratedNovelValue,
  resolveNovelChapterTitle,
  visibleCharCount,
} from "./novel-billable.js";

describe("novel billable text", () => {
  it("counts visible unicode characters and ignores whitespace", () => {
    expect(visibleCharCount("世 界\nA!")).toBe(4);
  });

  it("counts all author-visible values in PlotPilot setup output without JSON keys", () => {
    const raw = JSON.stringify({
      characters: [{ name: "林岚", role: "主角", coreMotivation: "夺回故乡" }],
      relations: [{ from: "林岚", to: "赵虎", relationType: "宿敌" }],
    });
    const visible = extractBillableText("setupCharacters", raw);
    expect(visible).toContain("林岚");
    expect(visible).toContain("夺回故乡");
    expect(visible).not.toContain("coreMotivation");
    expect(billableCharCount("setupCharacters", raw)).toBe(14);
  });

  it("requires structured JSON for setup generation", () => {
    expect(() => parseRequiredGeneratedNovelValue("setupPlot", "不是 JSON")).toThrow("不是完整 JSON");
  });

  it("keeps structured setup output available for diagnostics", () => {
    const display = formatGeneratedNovelDisplayText("setupBible", { styleGuide: { narrativeVoice: "克制冷峻" } });
    expect(display).toContain('"styleGuide"');
    expect(display).toContain("克制冷峻");
  });

  it("counts chapter body by final content field", () => {
    const raw = { title: "第一章", content: "雨夜里，林岚推开旧门。" };
    expect(extractBillableText("chapter", raw)).toBe("雨夜里，林岚推开旧门。");
    expect(billableCharCount("chapter", raw)).toBe(11);
  });

  it("parses the streaming-friendly chapter title header without saving it into the body", () => {
    const parsed = parseRequiredGeneratedNovelValue("chapter", "标题：逆向追踪\n\n林岚按下回车键。") as { title: string; content: string };
    expect(parsed).toEqual({ title: "逆向追踪", content: "林岚按下回车键。" });
    expect(formatGeneratedNovelDisplayText("chapter", parsed)).toBe("林岚按下回车键。");
  });

  it("preserves planned titles and replaces placeholder titles", () => {
    expect(resolveNovelChapterTitle({ requestedTitle: "锁灵坠", generatedTitle: "模型另拟标题", content: "正文", chapterIndex: 2 })).toBe("锁灵坠");
    expect(resolveNovelChapterTitle({ requestedTitle: "第 25 章", generatedTitle: "初代源码的秘密", content: "正文", chapterIndex: 25 })).toBe("初代源码的秘密");
    expect(resolveNovelChapterTitle({ requestedTitle: "第 26 章", content: "林岚发现逻辑锁背后的秘密。", chapterIndex: 26 })).not.toMatch(/^第\s*26\s*章$/u);
  });
});
