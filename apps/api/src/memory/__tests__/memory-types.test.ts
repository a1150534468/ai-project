import { describe, expect, it } from "vitest";
import { sanitizeMemoryShape } from "../memory-types.js";

describe("memory-types", () => {
  it("null 输入返回 null，不抛异常", () => {
    expect(() => sanitizeMemoryShape(null)).not.toThrow();
    expect(sanitizeMemoryShape(null)).toBeNull();
  });

  it("非对象输入返回 null，不抛异常", () => {
    expect(() => sanitizeMemoryShape("x")).not.toThrow();
    expect(sanitizeMemoryShape("x")).toBeNull();
  });
});
