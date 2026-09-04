/**
 * 记忆语义色板的约束。这套字面色类是 docs/design-system.md 特批的两处例外之一，
 * 唯一来源就是 `MEMORY_TYPE_STYLES` —— 少一个类型、或者哪个原子拼字符串生成，
 * Tailwind 扫不到就会静默丢规则，页面上只表现为「颜色没了」，很难查。
 */
import { describe, expect, it } from "vitest";
import { MEMORY_TYPE_ORDER } from "../../memoryGalaxy";
import { MEMORY_TYPE_STYLES, memoryChipClass, memoryDotClass, memoryEdgeClass, memoryPillClass } from "./memoryStyles";

describe("色板覆盖", () => {
  it("五类一个不缺，键就是 MEMORY_TYPE_ORDER", () => {
    expect(Object.keys(MEMORY_TYPE_STYLES).sort()).toEqual([...MEMORY_TYPE_ORDER].sort());
  });

  it("每类五个原子都是非空字面类名", () => {
    for (const type of MEMORY_TYPE_ORDER) {
      for (const [atom, value] of Object.entries(MEMORY_TYPE_STYLES[type])) {
        expect(value, `${type}.${atom}`).toMatch(/^[a-z][\w\-/[\].]*(\s[\w\-/[\].]+)*$/);
      }
    }
  });

  it("类型色互不相同，否则表格里根本分不出来", () => {
    const dots = MEMORY_TYPE_ORDER.map((type) => memoryDotClass(type));
    expect(new Set(dots).size).toBe(dots.length);
  });
});

describe("品牌色那一档走的是语义 token", () => {
  it("TEMPORARY 用 brand-soft / brand-ink，不用 bg-brand/10 —— 后者对比度只有 3:1 上下", () => {
    expect(memoryPillClass("TEMPORARY")).toBe("bg-brand-soft text-brand-ink");
    expect(memoryDotClass("TEMPORARY")).toBe("bg-brand");
    expect(memoryEdgeClass("TEMPORARY")).toBe("border-l-brand");
  });
});

describe("筛选 chip", () => {
  it("勾上了就带类型色描边", () => {
    expect(memoryChipClass("CORE", true)).toContain("border-amber-300");
  });

  it("没勾时默认是淡色底，留着类型的痕迹", () => {
    const idle = memoryChipClass("CORE", false);

    expect(idle).toContain("text-amber-700/80");
    expect(idle).not.toContain("border-amber-300");
  });

  it("neutral 档把类型色全收掉：编辑器里那排是单选，五个都染色反而看不出选了谁", () => {
    const idle = memoryChipClass("CORE", false, "neutral");

    expect(idle).toBe("border-hairline bg-surface text-ink-secondary");
  });

  it("neutral 档选中时和默认档一样带类型色", () => {
    expect(memoryChipClass("CORE", true, "neutral")).toBe(memoryChipClass("CORE", true));
  });
});
