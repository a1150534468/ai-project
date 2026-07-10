import { describe, it, expect } from "vitest";
import { buildExtractPrompt, buildBatchPrompt, parseVariants, deriveSeoKeywords } from "./fanout-prompts.js";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = {
  product: "AI 办公助手，一键生成 PPT",
  audience: "职场白领",
  sellingPoints: ["效率", "自动排版"],
  style: "口语",
  scene: "临时汇报",
};

describe("buildExtractPrompt", () => {
  it("system 要求输出 JSON，user 含原文", () => {
    const { system, user } = buildExtractPrompt("我们的AI助手一键生成PPT");
    expect(system).toMatch(/JSON/);
    expect(user).toContain("一键生成PPT");
  });
});

describe("buildBatchPrompt", () => {
  it("enum/platform 批：user 含标签与维度指令", () => {
    const { system, user } = buildBatchPrompt({
      mode: "enum", dimension: "platform", brief, labels: ["小红书", "抖音"],
    });
    expect(user).toContain("小红书");
    expect(user).toContain("抖音");
    expect(system).toMatch(/每行一条|逐条/);
  });
  it("script 批：要求脚本结构与 --- 分隔", () => {
    const { system } = buildBatchPrompt({
      mode: "script", brief, labels: ["15秒短视频", "60秒口播"],
    });
    expect(system).toMatch(/---/);
  });
});

describe("parseVariants", () => {
  it("enum：按行解析并配对标签", () => {
    const v = parseVariants("enum", "小红书文案A\n抖音文案B", ["小红书", "抖音"]);
    expect(v).toEqual([
      { label: "小红书", text: "小红书文案A" },
      { label: "抖音", text: "抖音文案B" },
    ]);
  });
  it("script：按 --- 分隔解析", () => {
    const v = parseVariants("script", "脚本一\n分镜\n---\n脚本二", ["15秒", "60秒"]);
    expect(v).toHaveLength(2);
    expect(v[0].text).toContain("脚本一");
    expect(v[1].label).toBe("60秒");
  });
  it("行数多于标签时用循环标签兜底（matrix 无严格配对）", () => {
    const v = parseVariants("matrix", "a\nb\nc", ["变体"]);
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.label === "变体")).toBe(true);
  });
});

describe("deriveSeoKeywords", () => {
  it("从 brief 产品名派生若干关键词种子", () => {
    const kws = deriveSeoKeywords(brief);
    expect(kws.length).toBeGreaterThan(0);
  });
});
