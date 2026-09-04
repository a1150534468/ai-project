import { describe, expect, it } from "vitest";
import { MEMORY_TYPE_ORDER, fallbackTitle, getMemoryTypeMeta, layoutMemoryNodes } from "./memoryGalaxy";
import type { MemoryNode } from "./memoryTypes";

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "memory-1",
    title: "默认标题",
    text: "默认记忆文本",
    type: "OTHER",
    importance: 50,
    tags: [],
    createdAt: "2026-06-29T00:00:00.000Z",
    lastUsedAt: null,
    usedCount: 0,
    ...overrides,
  };
}

/** 五类记忆轮着来、重要度铺满三档 —— 布局只看 id / type / importance，其余字段随便给。 */
function crowd(count: number): readonly MemoryNode[] {
  return Array.from({ length: count }, (_, index) =>
    node({
      id: `memory-${index + 1}`,
      title: `记忆 ${index + 1}`,
      type: MEMORY_TYPE_ORDER[index % MEMORY_TYPE_ORDER.length],
      importance: 35 + ((index * 11) % 61),
      usedCount: index,
    }),
  );
}

/** id → 落点。比对两次布局是否一致时用，比直接 toEqual 整个数组好读。 */
function spots(laidOut: readonly { readonly id: string; readonly x: number; readonly y: number }[]) {
  return Object.fromEntries(laidOut.map(({ id, x, y }) => [id, [x, y]]));
}

/** 所有两两距离里最小的那个：避让做得好不好就看这个数。 */
function closestPair(laidOut: readonly { readonly x: number; readonly y: number }[]): number {
  let closest = Number.POSITIVE_INFINITY;

  for (const [index, left] of laidOut.entries()) {
    for (const right of laidOut.slice(index + 1)) {
      closest = Math.min(closest, Math.hypot(left.x - right.x, left.y - right.y));
    }
  }

  return closest;
}

const SIZE_PROBES = [
  { importance: 0, size: "sm" },
  { importance: 59, size: "sm" },
  { importance: 60, size: "md" },
  { importance: 84, size: "md" },
  { importance: 85, size: "lg" },
  { importance: 100, size: "lg" },
] as const;

describe("layoutMemoryNodes", () => {
  it("同一批数据算两次，结果一模一样", () => {
    const nodes = crowd(9);

    expect(layoutMemoryNodes(nodes, 1280, 720)).toEqual(layoutMemoryNodes(nodes, 1280, 720));
  });

  it("入参顺序换了，每条记忆的落点不变", () => {
    const nodes = crowd(12);
    const forward = layoutMemoryNodes(nodes, 1280, 720);
    const backward = layoutMemoryNodes([...nodes].reverse(), 1280, 720);

    expect(spots(backward)).toEqual(spots(forward));
  });

  it("输出顺序跟着入参，布局顺序只决定谁先占位", () => {
    // CORE 排在方位表最前面，会先被放下，但输出里仍该是 z 在前
    const nodes = [node({ id: "z", type: "OTHER" }), node({ id: "a", type: "CORE" })];

    expect(layoutMemoryNodes(nodes, 1280, 720).map((item) => item.id)).toEqual(["z", "a"]);
  });

  it("大小档位卡在 60 / 85 两个阈值上", () => {
    const nodes = SIZE_PROBES.map((probe, index) => node({ id: `memory-${index}`, importance: probe.importance }));

    expect(layoutMemoryNodes(nodes, 800, 600).map((item) => item.size)).toEqual(SIZE_PROBES.map((probe) => probe.size));
  });

  it("手机画布上 15 条也全在框内", () => {
    for (const item of layoutMemoryNodes(crowd(15), 390, 844)) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(390);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(844);
    }
  });

  it("25 条挤在一起时两两至少隔开 24px", () => {
    expect(closestPair(layoutMemoryNodes(crowd(25), 1280, 720))).toBeGreaterThanOrEqual(24);
  });

  it("画布还没量出来（NaN）时退回桌面尺寸，坐标照样有限", () => {
    for (const item of layoutMemoryNodes(crowd(6), Number.NaN, Number.NaN)) {
      expect(Number.isFinite(item.x)).toBe(true);
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(1280);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(720);
    }
  });
});

describe("getMemoryTypeMeta", () => {
  it("五类记忆按方位顺序各有一个中文名", () => {
    expect(MEMORY_TYPE_ORDER.map((type) => getMemoryTypeMeta(type).label)).toEqual([
      "核心记忆",
      "常驻记忆",
      "临时记忆",
      "知识星云",
      "其他记忆",
    ]);
  });
});

const LONG_TITLE = "一二三四五六七八九十".repeat(3);

const TITLE_PROBES = [
  { what: "有标题就用标题，顺手去掉首尾空白", title: "  核心偏好  ", text: "正文", want: "核心偏好" },
  { what: "标题空了退回正文", title: "", text: "用户正在做 OpenClaw 云端项目", want: "用户正在做 OpenClaw 云端项目" },
  { what: "只有空白的标题也算空", title: "   \n ", text: "退回正文", want: "退回正文" },
  { what: "两边都空才给占位名", title: "", text: "", want: "未命名记忆" },
  { what: "超过 24 字截断加省略号", title: LONG_TITLE, text: "", want: `${LONG_TITLE.slice(0, 24)}...` },
  { what: "换行与连续空格折成一个空格", title: "上半句\n\n下半句", text: "", want: "上半句 下半句" },
  { what: "全角空格经 NFKC 归一后一样被折掉", title: "　全角　标题　", text: "", want: "全角 标题" },
] as const;

describe("fallbackTitle", () => {
  for (const probe of TITLE_PROBES) {
    it(probe.what, () => {
      expect(fallbackTitle(probe.title, probe.text)).toBe(probe.want);
    });
  }
});
