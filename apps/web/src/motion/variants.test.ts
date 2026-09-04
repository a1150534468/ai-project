import { describe, expect, it } from "vitest";
import { modalIn, msgIn, toastIn } from "./variants";
import { spring } from "./tokens";

/** `Variants` 的值是联合类型，测试里只关心目标态那一支，取的时候收一下窄。 */
function target(variants: typeof msgIn, name: "initial" | "animate" | "exit"): Record<string, unknown> {
  return variants[name] as Record<string, unknown>;
}

describe("三套入场的终态是共享的", () => {
  // 共享是有意的：改一处就是改全站手感，别单独给某一套调
  for (const [name, variants] of [
    ["msgIn", msgIn],
    ["toastIn", toastIn],
    ["modalIn", modalIn],
  ] as const) {
    it(`${name} 的 animate 回到中立位并用 bouncy`, () => {
      expect(target(variants, "animate")).toEqual({
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        transition: spring.bouncy,
      });
    });
  }
});

describe("入场前一律全透明", () => {
  for (const [name, variants] of [
    ["msgIn", msgIn],
    ["toastIn", toastIn],
    ["modalIn", modalIn],
  ] as const) {
    it(`${name} 的 initial 是 opacity 0`, () => {
      expect(target(variants, "initial").opacity).toBe(0);
    });
  }
});

describe("退场", () => {
  it("用固定时长而不是弹簧 —— 元素在往外走，回弹会显得没走干净", () => {
    expect(target(toastIn, "exit").transition).toEqual({ duration: 0.2 });
    expect(target(modalIn, "exit").transition).toEqual({ duration: 0.18 });
  });

  it("Toast 进出同一个位姿：它钉在右下角，得从同一侧出去", () => {
    const { opacity, x, scale } = target(toastIn, "exit");

    expect({ opacity, x, scale }).toEqual(target(toastIn, "initial"));
  });

  it("聊天气泡没有退场：消息只会追加，不会单条消失", () => {
    expect(msgIn.exit).toBeUndefined();
  });
});
