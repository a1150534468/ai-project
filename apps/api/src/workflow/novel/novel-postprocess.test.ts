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

  it("keeps only the final hook question instead of turning dialogue into five foreshadows", () => {
    const result = buildNovelChapterPostprocessPayload({
      projectTitle: "寒泉烬",
      chapterIndex: 5,
      title: "追兵",
      content: "“你懂硬件？”赵虎问。“你在干嘛？”林岚没有回答。门外忽然传来脚步声。来的人究竟是谁？",
      knownCharacters: ["林岚", "赵虎"],
      knownLocations: [],
    });

    expect(result.summary.openThreads).toEqual(["来的人究竟是谁？"]);
    expect(result.foreshadowItems).toHaveLength(1);
  });

  it("does not register a rhetorical taunt as a durable open thread", () => {
    const result = buildNovelChapterPostprocessPayload({
      projectTitle: "寒泉烬",
      chapterIndex: 6,
      title: "打断点",
      content: "追兵堵住出口。苏橙看着机械键盘发抖：“不用脑机辅助，真写啊？”",
      knownCharacters: ["苏橙"],
      knownLocations: [],
    });

    expect(result.summary.openThreads).toEqual([]);
    expect(result.foreshadowItems).toEqual([]);
  });

  it("registers an unresolved statement hook even when it is not phrased as a question", () => {
    const result = buildNovelChapterPostprocessPayload({
      projectTitle: "寒泉烬",
      chapterIndex: 7,
      title: "活体代码",
      content: "屏幕上的暗红源码完全无法被解析。林岚知道，真正的猎手刚刚才露出獠牙。",
      knownCharacters: ["林岚"],
      knownLocations: [],
    });

    expect(result.summary.openThreads).toHaveLength(1);
    expect(result.summary.openThreads[0]).toMatch(/无法被解析|真正的猎手/);
  });
});
