import { describe, expect, it } from "vitest";
import { envInt, intOr } from "./env.js";

/**
 * 表驱动：这 15 处调用点原先各自判定「什么叫一个合法的正整数」，口径漂成四种。
 * 这份表就是合并后的契约——新增调用点只许调 envInt / intOr，不许再写一份判定。
 */
const cases: { label: string; raw: string | undefined; fallback: number; expected: number }[] = [
  { label: "没配", raw: undefined, fallback: 8, expected: 8 },
  { label: "空串（与没配同义，不被当成 0）", raw: "", fallback: 8, expected: 8 },
  { label: "只有空格", raw: "   ", fallback: 8, expected: 8 },
  { label: "正常值", raw: "16", fallback: 8, expected: 16 },
  { label: "带空格的数字", raw: " 16 ", fallback: 8, expected: 16 },
  { label: "0（默认不合法）", raw: "0", fallback: 8, expected: 8 },
  { label: "负数", raw: "-1", fallback: 8, expected: 8 },
  { label: "非数字字符串", raw: "abc", fallback: 8, expected: 8 },
  { label: "NaN 字面量", raw: "NaN", fallback: 8, expected: 8 },
  { label: "Infinity", raw: "Infinity", fallback: 8, expected: 8 },
  { label: "小数（不是整数）", raw: "8.5", fallback: 8, expected: 8 },
  { label: "巨大值（超出安全整数）", raw: "99999999999999999999", fallback: 8, expected: 8 },
  { label: "十六进制字符串", raw: "0x10", fallback: 8, expected: 16 },
];

describe("envInt", () => {
  for (const { label, raw, fallback, expected } of cases) {
    it(`${label} → ${expected}`, () => {
      const env = raw === undefined ? {} : { ANY: raw };
      expect(envInt(env, "ANY", fallback)).toBe(expected);
    });
  }

  it("allowZero 打开时 0 是合法取值", () => {
    expect(envInt({ ANY: "0" }, "ANY", 4, { allowZero: true })).toBe(0);
  });

  it("allowZero 打开时负数仍然退回默认", () => {
    expect(envInt({ ANY: "-1" }, "ANY", 4, { allowZero: true })).toBe(4);
  });

  it("allowZero 打开时空串仍然是「没配」，不是 0", () => {
    expect(envInt({ ANY: "" }, "ANY", 4, { allowZero: true })).toBe(4);
  });
});

describe("intOr（options 覆盖 env 用）", () => {
  it("数字 0 在 allowZero 关闭时退回默认", () => {
    expect(intOr(0, 3)).toBe(3);
  });

  it("数字 0 在 allowZero 打开时被接受", () => {
    expect(intOr(0, 3, { allowZero: true })).toBe(0);
  });

  it("undefined / null 退回默认", () => {
    expect(intOr(undefined, 3)).toBe(3);
    expect(intOr(null, 3)).toBe(3);
  });

  it("数字与数字字符串一视同仁", () => {
    expect(intOr(12, 3)).toBe(12);
    expect(intOr("12", 3)).toBe(12);
  });
});
