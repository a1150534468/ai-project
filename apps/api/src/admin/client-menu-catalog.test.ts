import { describe, expect, it } from "vitest";
import { resolveClientMenuItems } from "./client-menu-catalog.js";

describe("resolveClientMenuItems", () => {
  it("默认隐藏尚未开放的工作流入口", () => {
    const items = resolveClientMenuItems([]);
    const hidden = items.filter((item) => !item.visible).map((item) => item.key);
    expect(hidden).toEqual([
      "workflow.codex-pet",
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
      { key: "workflow.codex-pet", visible: true },
      { key: "workflow.report", visible: true },
      { key: "nav.models", visible: false },
    ]);
    expect(items.find((item) => item.key === "workflow.codex-pet")?.visible).toBe(true);
    expect(items.find((item) => item.key === "workflow.report")?.visible).toBe(true);
    expect(items.find((item) => item.key === "nav.models")?.visible).toBe(false);
  });

  it("生图模块的三个页内 tab 作为三级菜单默认开启，旧电商图二级菜单已下线", () => {
    const items = resolveClientMenuItems([]);
    const tabs = items.filter((item) => item.parentKey === "workflow.image");
    expect(tabs.map((tab) => tab.key)).toEqual([
      "workflow.image.general",
      "workflow.image.ecom",
      "workflow.image.portrait",
    ]);
    expect(tabs.every((tab) => tab.visible)).toBe(true);
    expect(items.some((item) => item.key === "workflow.commerce-long-image")).toBe(false);
  });

  it("旧 AI 电商图开关沿用到电商生图 tab，新 key 优先", () => {
    const legacyOnly = resolveClientMenuItems([
      { key: "workflow.commerce-long-image", visible: false },
    ]);
    expect(legacyOnly.find((item) => item.key === "workflow.image.ecom")?.visible).toBe(false);

    const bothKeys = resolveClientMenuItems([
      { key: "workflow.commerce-long-image", visible: false },
      { key: "workflow.image.ecom", visible: true },
    ]);
    expect(bothKeys.find((item) => item.key === "workflow.image.ecom")?.visible).toBe(true);
  });
});
