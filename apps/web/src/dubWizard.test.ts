import { describe, it, expect } from "vitest";
import { STAGES, stageIndex, nextStage, prevStage, estimatePerUnit, estimatePerCall, canLeaveStage, effectiveScript } from "./dubWizard";

describe("stage 机", () => {
  it("顺序固定", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["source", "analysis", "rewrite", "voice", "avatar", "bgm", "result"]);
  });
  it("stageIndex / next / prev", () => {
    expect(stageIndex("voice")).toBe(3);
    expect(nextStage("voice")).toBe("avatar");
    expect(prevStage("voice")).toBe("rewrite");
    expect(nextStage("result")).toBe("result");
    expect(prevStage("source")).toBe("source");
  });
});

describe("消耗估算", () => {
  it("PER_UNIT: ceil(rate*units/perUnits)", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: true }, 30)).toBe(30);
    expect(estimatePerUnit({ rate: 1, perUnits: 100, enabled: true }, 250)).toBe(3);
  });
  it("PER_CALL: ceil(rate)", () => {
    expect(estimatePerCall({ rate: 99.2, perUnits: 1, enabled: true })).toBe(100);
  });
  it("未启用返回 null（前端据此置灰）", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: false }, 30)).toBeNull();
    expect(estimatePerCall({ rate: 1, perUnits: 1, enabled: false })).toBeNull();
  });
  it("units<=0 视为 0 点", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: true }, 0)).toBe(0);
  });
  it("perUnits<=0 兜底为 1，不除零", () => {
    expect(estimatePerUnit({ rate: 2, perUnits: 0, enabled: true }, 3)).toBe(6);
  });
});

describe("effectiveScript", () => {
  it("优先洗稿结果，否则原口播文稿", () => {
    expect(effectiveScript({ spokenScript: "原", script: "洗" })).toBe("洗");
    expect(effectiveScript({ spokenScript: "原", script: "" })).toBe("原");
    expect(effectiveScript({ spokenScript: "  ", script: "" })).toBe("");
  });
});

describe("canLeaveStage", () => {
  const empty = { spokenScript: "", script: "", audioObjectKey: null, avatarId: null };
  it("source 需要有文稿", () => {
    expect(canLeaveStage("source", empty)).toBe(false);
    expect(canLeaveStage("source", { ...empty, spokenScript: "你好" })).toBe(true);
  });
  it("rewrite 需要最终文案（洗稿或原稿均可）", () => {
    expect(canLeaveStage("rewrite", { ...empty, spokenScript: "原稿" })).toBe(true);
    expect(canLeaveStage("rewrite", empty)).toBe(false);
  });
  it("voice 需要音频", () => {
    expect(canLeaveStage("voice", { ...empty, script: "x" })).toBe(false);
    expect(canLeaveStage("voice", { ...empty, script: "x", audioObjectKey: "k" })).toBe(true);
  });
  it("avatar 需要选中形象", () => {
    expect(canLeaveStage("avatar", { ...empty, audioObjectKey: "k" })).toBe(false);
    expect(canLeaveStage("avatar", { ...empty, audioObjectKey: "k", avatarId: "a" })).toBe(true);
  });
  it("bgm 可选，总能继续", () => {
    expect(canLeaveStage("bgm", empty)).toBe(true);
  });
});
