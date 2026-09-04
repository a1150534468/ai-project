import { describe, it, expect } from "vitest";
import {
  easeOutCubic,
  interpolateCount,
  formatCount,
  toastReducer,
  type ToastState,
  shouldRenderDecoration,
} from "./anim";

describe("easeOutCubic", () => {
  it("maps 0->0 and 1->1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
  it("is monotonic increasing and front-loaded", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // 先快后慢
    expect(easeOutCubic(0.25)).toBeLessThan(easeOutCubic(0.5));
  });
  it("clamps out-of-range input", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("interpolateCount", () => {
  it("returns from at p=0 and to at p=1", () => {
    expect(interpolateCount(100, 500, 0)).toBe(100);
    expect(interpolateCount(100, 500, 1)).toBe(500);
  });
  it("rounds to integer by default", () => {
    expect(Number.isInteger(interpolateCount(0, 3, 0.5))).toBe(true);
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(12480)).toBe("12,480");
  });
});

describe("toastReducer", () => {
  const empty: ToastState = { items: [] };
  it("adds a toast with the given id", () => {
    const s = toastReducer(empty, { type: "add", toast: { id: "a", kind: "ok", text: "ok" } });
    expect(s.items).toHaveLength(1);
    expect(s.items[0].id).toBe("a");
  });
  it("removes a toast by id", () => {
    const s1 = toastReducer(empty, { type: "add", toast: { id: "a", kind: "ok", text: "ok" } });
    const s2 = toastReducer(s1, { type: "remove", id: "a" });
    expect(s2.items).toHaveLength(0);
  });
  it("does not mutate previous state (immutability)", () => {
    const s1 = toastReducer(empty, { type: "add", toast: { id: "a", kind: "ok", text: "ok" } });
    expect(empty.items).toHaveLength(0);
    expect(s1).not.toBe(empty);
  });
});

describe("shouldRenderDecoration", () => {
  it("is false when reduced motion is requested", () => {
    expect(shouldRenderDecoration(true)).toBe(false);
    expect(shouldRenderDecoration(false)).toBe(true);
  });
});
