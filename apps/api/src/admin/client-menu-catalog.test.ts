import { describe, expect, it } from "vitest";
import { resolveClientMenuItems } from "./client-menu-catalog.js";

describe("resolveClientMenuItems", () => {
  it("默认隐藏截图中的七个工作流入口", () => {
    const items = resolveClientMenuItems([]);
    const hidden = items.filter((item) => !item.visible).map((item) => item.key);
    expect(hidden).toEqual([
      "workflow.report",
      "workflow.fanout",
      "workflow.article-workflow",
      "workflow.local-business-promo",
      "workflow.ai-comic",
      "workflow.scheduled-task",
      "workflow.ppt",
    ]);
  });

  it("数据库配置覆盖目录默认值", () => {
    const items = resolveClientMenuItems([
      { key: "workflow.report", visible: true },
      { key: "nav.models", visible: false },
    ]);
    expect(items.find((item) => item.key === "workflow.report")?.visible).toBe(true);
    expect(items.find((item) => item.key === "nav.models")?.visible).toBe(false);
  });
});
