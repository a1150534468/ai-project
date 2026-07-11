import { describe, expect, it } from "vitest";
import { buildNovelReviewPayload, estimateNovelModificationRate } from "./novel-review.js";

describe("novel review", () => {
  it("estimates modification rate from raw and revised content", () => {
    expect(estimateNovelModificationRate("abcdef", "abcXYZ")).toBe(50);
    expect(estimateNovelModificationRate("", "新稿")).toBe(100);
  });

  it("suggests revise when chapter has low modification rate and quality risks", () => {
    const payload = buildNovelReviewPayload({
      rawContent: "嘴角微微上扬。嘴角微微上扬。",
      finalContent: "嘴角微微上扬。嘴角微微上扬。",
      summary: "重复表达明显。",
      openThreads: [],
      consistencyRisks: ["章节字数偏低"],
    });

    expect(payload.modificationRate).toBe(0);
    expect(payload.suggestedStatus).toBe("revise");
    expect(payload.aiActionItems.join("\n")).toContain("人工改稿幅度偏低");
  });
});
