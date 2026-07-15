import { describe, expect, it } from "vitest";
import { buildNovelRevisionGuidance } from "./revision.js";

describe("novel revision guidance", () => {
  it("combines length, gate, and editorial guidance without duplicates", () => {
    expect(buildNovelRevisionGuidance({
      billableChars: 1793,
      targetChars: 3000,
      gateReasons: ["一致性评分低于 65%"],
      actionItems: ["强化结尾钩子", "强化结尾钩子"],
    })).toEqual([
      "当前正文仅 1793 字，重写后不得少于 2700 字",
      "一致性评分低于 65%",
      "强化结尾钩子",
    ]);
  });
});
