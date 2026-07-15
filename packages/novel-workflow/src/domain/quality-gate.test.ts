import { describe, expect, it } from "vitest";
import { evaluateNovelQualityGate } from "./quality-gate.js";

describe("novel quality gate", () => {
  const healthy = {
    consistencyScore: 0.9,
    styleScore: 0.9,
    tensionScore: 0.8,
    highSeverityIssues: 0,
    criticalIssues: 0,
  };

  it("passes healthy chapter metrics at an acceptable length", () => {
    expect(evaluateNovelQualityGate({ ...healthy, contentChars: 2600, targetChars: 3000 }).passed).toBe(true);
  });

  it("blocks a severely undersized chapter", () => {
    expect(evaluateNovelQualityGate({ ...healthy, contentChars: 1793, targetChars: 3000 })).toMatchObject({
      passed: false,
      reasons: ["正文字数 1793，低于目标 3000 的 80%"],
    });
  });
});
