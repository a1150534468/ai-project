import { describe, expect, it } from "vitest";
import { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";

describe("novel postprocess", () => {
  it("builds summary, open threads, facts, foreshadow and consistency payload", () => {
    const result = buildNovelChapterPostprocessPayload({
      projectTitle: "寒泉烬",
      chapterIndex: 2,
      title: "锁灵坠",
      content: "林岚在寒泉院发现密信。赵虎为何知道锁灵坠？她决定追查真相。",
      knownCharacters: ["林岚", "赵虎"],
      knownLocations: ["寒泉院"],
    });

    expect(result.summary.summary).toContain("发现密信");
    expect(result.summary.openThreads[0]).toContain("为何");
    expect(result.facts.map((item) => item.subject)).toContain("林岚");
    expect(result.foreshadowItems[0]?.title).toContain("赵虎为何知道锁灵坠");
    expect(result.consistencyStatus.chapterAssets.eventCards.length).toBeGreaterThan(0);
  });
});
