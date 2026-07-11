import { describe, expect, it } from "vitest";
import { buildNovelEnhancedContextText, buildNovelGenerationContext } from "./novel-context-builder.js";

describe("novel context builder", () => {
  it("builds fqxs-style layered context for a target chapter", () => {
    const payload = buildNovelGenerationContext({
      project: { id: "project-1", title: "寒泉烬", genre: "玄幻" },
      chapterIndex: 4,
      chapterTitle: "血脉回响",
      chapterSummary: "回收锁灵坠伏笔。",
      sections: [
        { kind: "world", displayText: "寒泉院只能由沈氏血脉进入。", structuredJson: null },
        { kind: "chars", displayText: "林岚：主角。\n赵虎：反派。", structuredJson: null },
        { kind: "style", displayText: "短句推进，结尾留钩子。", structuredJson: null },
      ],
      previousChapters: [
        { id: "c1", chapterIndex: 1, title: "寒泉院", summary: "林岚发现锁灵坠。", content: "林岚发现锁灵坠。" },
      ],
      facts: [{ subject: "锁灵坠", predicate: "能力", object: "护住心脉", sourceExcerpt: "锁灵坠护住心脉", confidence: 0.9, status: "confirmed" }],
      foreshadowItems: [{ title: "锁灵坠来历", description: "锁灵坠与沈氏血脉相关。", expectedPayoffChapter: 4, status: "open", relatedCharacter: "林岚" }],
      reviewFeedback: [],
    });

    expect(payload.focusCard.mission).toContain("回收锁灵坠伏笔");
    expect(payload.focusCard.mustPayoff).toContain("锁灵坠来历");
    expect(payload.continuityAlerts.map((item) => item.title)).toContain("伏笔接近回收窗口");
    expect(payload.contextLayers.foundation.join("\n")).toContain("寒泉院");

    const text = buildNovelEnhancedContextText(payload);
    expect(text).toContain("【章节任务卡】");
    expect(text).toContain("【稳定事实】");
    expect(text).toContain("【伏笔账本】");
  });
});
