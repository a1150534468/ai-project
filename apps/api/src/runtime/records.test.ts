import { describe, expect, it } from "vitest";
import { isObjectLike, isPlainObject } from "./records.js";

describe("对象守卫", () => {
  it("两者都放过普通对象", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isObjectLike({ a: 1 })).toBe(true);
  });

  it("两者都拦住 null 与原始值", () => {
    for (const value of [null, undefined, 0, "", "x", false, Symbol("s")]) {
      expect(isPlainObject(value)).toBe(false);
      expect(isObjectLike(value)).toBe(false);
    }
  });

  it("唯一的区别是数组：isPlainObject 拦，isObjectLike 放", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([{ a: 1 }])).toBe(false);
    expect(isObjectLike([])).toBe(true);
    expect(isObjectLike([{ a: 1 }])).toBe(true);
  });

  it("class 实例、Date 这类非字面量对象两者都放过（没有做 prototype 检查）", () => {
    expect(isPlainObject(new Date())).toBe(true);
    expect(isPlainObject(new Error("e"))).toBe(true);
    expect(isObjectLike(new Error("e"))).toBe(true);
  });
});
