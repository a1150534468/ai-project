import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_MENU_VISIBILITY,
  clientMenuKeyForView,
  firstVisibleClientView,
  isClientMenuVisible,
  isWorkflowSubVisible,
  visibleImageHubTabs,
} from "./clientMenu";

describe("clientMenu", () => {
  it("默认隐藏灰度中的 Codex 桌宠及其他工作流入口，其他入口显示", () => {
    expect(isClientMenuVisible(DEFAULT_CLIENT_MENU_VISIBILITY, "workflow.codex-pet")).toBe(false);
    expect(isClientMenuVisible(DEFAULT_CLIENT_MENU_VISIBILITY, "workflow.report")).toBe(false);
    expect(isClientMenuVisible(DEFAULT_CLIENT_MENU_VISIBILITY, "workflow.scheduled-task")).toBe(false);
    expect(isClientMenuVisible(DEFAULT_CLIENT_MENU_VISIBILITY, "workflow.image")).toBe(true);
    expect(isClientMenuVisible(DEFAULT_CLIENT_MENU_VISIBILITY, "nav.chat")).toBe(true);
  });

  it("将普通页面映射到主菜单配置，工作流和充值由调用方单独判断", () => {
    expect(clientMenuKeyForView("models")).toBe("nav.models");
    expect(clientMenuKeyForView("workflow")).toBeNull();
    expect(clientMenuKeyForView("report")).toBeNull();
    expect(clientMenuKeyForView("billing")).toBeNull();
  });

  it("当前入口隐藏后选择仍显示的主菜单作为落点", () => {
    expect(firstVisibleClientView({ "nav.chat": false, "nav.models": true })).toBe("models");
  });

  it("生图模块页内 tab 按后台开关过滤", () => {
    expect(visibleImageHubTabs(undefined).map((tab) => tab.id)).toEqual(["general", "ecom", "portrait", "try-on"]);
    expect(visibleImageHubTabs({ "workflow.image.ecom": false }).map((tab) => tab.id)).toEqual([
      "general",
      "portrait",
      "try-on",
    ]);
  });

  it("生图模块四个 tab 全关时二级入口一并隐藏", () => {
    const allTabsOff = {
      "workflow.image.general": false,
      "workflow.image.ecom": false,
      "workflow.image.portrait": false,
      "workflow.image.try-on": false,
    };
    expect(isWorkflowSubVisible(allTabsOff, "image")).toBe(false);
    expect(isWorkflowSubVisible({ "workflow.image.ecom": false }, "image")).toBe(true);
    expect(isWorkflowSubVisible({ "workflow.image": false }, "image")).toBe(false);
    expect(isWorkflowSubVisible(undefined, "novel")).toBe(true);
    expect(isWorkflowSubVisible(undefined, "codex-pet")).toBe(false);
    // 旧的电商图模块 id 落到生图模块的开关上
    expect(isWorkflowSubVisible({ "workflow.image": false }, "commerce-long-image")).toBe(false);
  });
});
