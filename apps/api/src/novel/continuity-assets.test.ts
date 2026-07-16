import { describe, expect, it } from "vitest";
import { deriveNovelContinuityAssets } from "./continuity-assets.js";

describe("novel continuity assets", () => {
  it("derives world timeline rows from chapter event cards", () => {
    const result = deriveNovelContinuityAssets({
      chapterIndex: 3,
      title: "密钥转移",
      content: "次日清晨，林岚在寒泉院发现密信。",
      eventCards: [{ label: "林岚发现密信", eventType: "reveal", tensionLevel: "medium", actors: ["林岚"], locations: ["寒泉院"], evidence: "次日清晨，林岚在寒泉院发现密信。" }],
      knownCharacters: ["林岚"],
      knownLocations: ["寒泉院"],
    });

    expect(result.timeline).toEqual([expect.objectContaining({ timeLabel: "次日", participants: ["林岚"] })]);
  });

  it("extracts prop ownership, transfer, location and terminal state", () => {
    const result = deriveNovelContinuityAssets({
      chapterIndex: 5,
      title: "锁灵坠",
      content: "林岚在寒泉院拿起锁灵坠，随后把管理员令牌交给赵虎。追兵最终毁掉备用硬盘。",
      eventCards: [],
      knownCharacters: ["林岚", "赵虎"],
      knownLocations: ["寒泉院"],
    });

    expect(result.props).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "锁灵坠", owner: "林岚", location: "寒泉院", eventType: "acquired" }),
      expect.objectContaining({ name: "管理员令牌", owner: "赵虎", eventType: "transferred" }),
      expect.objectContaining({ name: "备用硬盘", status: "destroyed", eventType: "destroyed" }),
    ]));
  });
});
