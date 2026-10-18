/**
 * 三区几何的**产物守卫**。
 *
 * 这个文件存在的唯一理由，是下面那类事故不能再来一次：`wfShell()` 曾经把 `grid-cols-[` 留在公共前缀里、
 * 运行时再拼列宽。Tailwind 只扫源码里的完整字面量，拼出来的类名它不认识 ⇒ `xl:grid` 生成了、
 * 列定义没生成 ⇒ 宽屏下 `display:grid` 但没有 `grid-template-columns`，三区**全部纵向堆叠**。
 * 三层检查全绿：`tsc` 不看类名、jsdom 不套 CSS、dev server 还留着上一轮产物。是用户在界面上发现的。
 *
 * 所以这里不测行为（行为在 studio 的单测里），只钉住一条**工程约束**：
 * 凡是带 `[` 或 `:` 的 Tailwind 候选类（任意值、变体前缀），都必须能在源码里**逐字**找到。
 * 拼出来的 token 一定找不到 —— 那一刻这条测试就红，而不是等到用户看见一列到底的界面。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WF_SHELL_FORM, wfShell } from "./workflowLayout";

const SOURCE_PATH = fileURLToPath(new URL("./workflowLayout.ts", import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

/** Tailwind 的候选类：任意值（`[`）或变体前缀（`:`）都要它亲自在源码里读到才会生成。 */
function riskyTokens(className: string): readonly string[] {
  return className.split(/\s+/).filter((token) => token.includes("[") || token.includes(":"));
}

/** 四种面板组合 + B 形态（小说创建）。 */
const COMBOS: readonly string[] = [
  wfShell(true, true),
  wfShell(true, false),
  wfShell(false, true),
  wfShell(false, false),
  WF_SHELL_FORM,
];

describe("几何类必须能被 Tailwind 扫到", () => {
  it("每一种组合的候选类都逐字出现在源码里", () => {
    for (const className of COMBOS) {
      for (const token of riskyTokens(className)) {
        expect(
          SOURCE,
          `「${token}」是拼出来的 —— Tailwind 扫不到它，规则不会进 CSS，界面会悄悄掉成单列`,
        ).toContain(token);
      }
    }
  });

  it("列宽与原型一致：1440 下左右 ≈300 / 280，且两侧带像素下限、多出来的宽度按比例分", () => {
    expect(wfShell(true, true)).toContain(
      "xl:grid-cols-[minmax(280px,22%)_minmax(0,1fr)_minmax(260px,20.5%)]",
    );
    expect(wfShell(true, false)).toContain("xl:grid-cols-[minmax(280px,22%)_minmax(0,1fr)]");
    expect(wfShell(false, true)).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(260px,20.5%)]");
    expect(wfShell(false, false)).toContain("xl:grid-cols-[minmax(0,1fr)]");
    expect(WF_SHELL_FORM).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(260px,20.5%)]");

    // 百分比是对**栅格容器的内容宽**算的：1440 的视口下容器内容宽 ≈ 1356（视口 − 84），
    // 22% ≈ 298、20.5% ≈ 278，与原型 layout3 的 300 / 280 差在 2px 以内。
    // 写死像素的话，宽屏上多出来的宽度会全归中间，设置栏被挤成一条（2560 时只占 11.7%）。
    const contentWidth = 1440 - 84;
    const [left, right] = [0.22, 0.205].map((ratio) => Math.round(contentWidth * ratio));
    expect(left).toBeGreaterThanOrEqual(296);
    expect(left).toBeLessThanOrEqual(304);
    expect(right).toBeGreaterThanOrEqual(276);
    expect(right).toBeLessThanOrEqual(284);
  });

  it("窄屏纵向堆叠、横排从 xl 起 —— 两件事都写在外壳上", () => {
    for (const className of COMBOS) {
      expect(className).toContain("flex-col");
      expect(className).toContain("xl:grid");
    }
  });

  it("行高锁在容器上（`xl:grid-rows-1`）：少了它，最高的一栏会把三张卡一起撑高", () => {
    for (const className of COMBOS) {
      // 只定列不定行 ⇒ 隐式 auto 行 ⇒ 工作区被设置栏撑到两三千像素、底边被裁掉。
      expect(className).toContain("xl:grid-rows-1");
      expect(className).toContain("xl:overflow-hidden");
    }
  });
});
