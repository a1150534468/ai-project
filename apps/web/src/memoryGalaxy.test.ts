import { describe, expect, it } from "vitest";
import type { MemoryNode } from "./memoryTypes";
import { fallbackTitle, getMemoryTypeMeta, layoutMemoryNodes } from "./memoryGalaxy";

const buildNode = (overrides: Partial<MemoryNode> = {}): MemoryNode => ({
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
});

function buildRepresentativeNodes(count: number): readonly MemoryNode[] {
  const types = ["CORE", "PERMANENT", "TEMPORARY", "KNOWLEDGE", "OTHER"] as const;

  return Array.from({ length: count }, (_, index) =>
    buildNode({
      id: `memory-${index + 1}`,
      title: `记忆 ${index + 1}`,
      text: `这是第 ${index + 1} 条代表性记忆，用于测试星河布局的稳定性与避让效果。`,
      type: types[index % types.length],
      importance: 35 + ((index * 11) % 61),
      usedCount: index,
    }),
  );
}

function getMinimumPairDistance(nodes: readonly { readonly x: number; readonly y: number }[]): number {
  let minimum = Number.POSITIVE_INFINITY;

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      if (!right) {
        continue;
      }

      const dx = left.x - right.x;
      const dy = left.y - right.y;
      minimum = Math.min(minimum, Math.hypot(dx, dy));
    }
  }

  return minimum;
}

describe("memoryGalaxy helpers", () => {
  it("layoutMemoryNodes returns stable positions for the same nodes", () => {
    const nodes = [
      buildNode({ id: "memory-core", type: "CORE", importance: 90 }),
      buildNode({ id: "memory-permanent", type: "PERMANENT", importance: 60 }),
      buildNode({ id: "memory-other", type: "OTHER", importance: 30 }),
    ] as const;

    const first = layoutMemoryNodes(nodes, 1280, 720);
    const second = layoutMemoryNodes(nodes, 1280, 720);

    expect(second).toEqual(first);
    expect(first.map((node) => node.size)).toEqual(["lg", "md", "sm"]);
  });

  it("layoutMemoryNodes keeps representative mobile nodes inside bounds", () => {
    const laidOut = layoutMemoryNodes(buildRepresentativeNodes(15), 390, 844);

    for (const node of laidOut) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(390);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(844);
    }
  });

  it("layoutMemoryNodes uses semantic size thresholds at 60 and 85", () => {
    const nodes = [
      buildNode({ id: "memory-59", importance: 59 }),
      buildNode({ id: "memory-60", importance: 60 }),
      buildNode({ id: "memory-84", importance: 84 }),
      buildNode({ id: "memory-85", importance: 85 }),
    ] as const;

    const laidOut = layoutMemoryNodes(nodes, 800, 600);

    expect(laidOut.map((node) => node.size)).toEqual(["sm", "md", "md", "lg"]);
  });

  it("layoutMemoryNodes keeps dense representative nodes pragmatically spaced", () => {
    const laidOut = layoutMemoryNodes(buildRepresentativeNodes(25), 1280, 720);

    expect(getMinimumPairDistance(laidOut)).toBeGreaterThanOrEqual(24);
  });

  it("getMemoryTypeMeta maps labels", () => {
    const core = getMemoryTypeMeta("CORE");
    const other = getMemoryTypeMeta("OTHER");

    expect(core.label).toBe("核心记忆");
    expect(other.label).toBe("其他记忆");
  });

  it("fallbackTitle returns compact text when title is empty", () => {
    expect(fallbackTitle("", "用户正在做 OpenClaw 云端项目")).toBe("用户正在做 OpenClaw 云端项目");
  });
});
