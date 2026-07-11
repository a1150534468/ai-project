import { describe, expect, it } from "vitest";
import { buildNovelQualityDiagnostics, deriveNovelChapterAssets, splitNovelSentences } from "./novel-text-analysis.js";

describe("novel text analysis", () => {
  it("splits Chinese chapter text into sentence-like units", () => {
    expect(splitNovelSentences("林岚停住脚步。门外有人？她握紧剑！")).toEqual([
      "林岚停住脚步。",
      "门外有人？",
      "她握紧剑！",
    ]);
  });

  it("derives character and location mentions from known names", () => {
    const result = deriveNovelChapterAssets({
      content: "林岚在寒泉院发现密信。赵虎随后闯入寒泉院质问她。",
      characters: ["林岚", "赵虎"],
      locations: ["寒泉院"],
    });

    expect(result.characterMentions.map((item) => item.name)).toEqual(["林岚", "赵虎"]);
    expect(result.locationMentions[0]).toMatchObject({ name: "寒泉院", count: 2 });
    expect(result.eventCards[0]?.evidence).toContain("发现密信");
  });

  it("flags low quality chapter text with concrete issues", () => {
    const result = buildNovelQualityDiagnostics("嘴角微微上扬。嘴角微微上扬。门外没有钩子。");

    expect(result.score).toBeLessThan(100);
    expect(result.issues.map((item) => item.code)).toContain("low_word_count");
    expect(result.clicheHits).toContain("嘴角微微上扬");
  });
});
