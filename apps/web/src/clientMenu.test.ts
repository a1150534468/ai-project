import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_MENU_VISIBILITY,
  clientMenuKeyForView,
  firstVisibleClientView,
  isClientMenuVisible,
} from "./clientMenu";

describe("clientMenu", () => {
  it("默认隐藏指定的七个工作流入口，其他入口显示", () => {
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
});
