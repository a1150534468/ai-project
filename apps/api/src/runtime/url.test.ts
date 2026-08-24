import { describe, expect, it } from "vitest";
import { trimTrailingSlash } from "./url.js";

describe("trimTrailingSlash", () => {
  it("削掉末尾连续多个斜杠", () => {
    expect(trimTrailingSlash("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(trimTrailingSlash("https://cdn.example.com///")).toBe("https://cdn.example.com");
  });

  it("没有末尾斜杠时原样返回", () => {
    expect(trimTrailingSlash("https://cdn.example.com")).toBe("https://cdn.example.com");
    expect(trimTrailingSlash("")).toBe("");
  });

  it("只削末尾，路径中间的斜杠不动", () => {
    expect(trimTrailingSlash("https://cdn.example.com/a//b/")).toBe("https://cdn.example.com/a//b");
  });
});
