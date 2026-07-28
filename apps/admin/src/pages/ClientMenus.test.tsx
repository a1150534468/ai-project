import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { ClientMenusPage } from "./ClientMenus.js";

vi.mock("../api.js", () => ({
  listClientMenus: vi.fn(),
  updateClientMenu: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function menu(
  key: string,
  label: string,
  group: "main" | "workflow",
  visible: boolean,
  parentKey?: string,
): api.ClientMenuItem {
  return { key, label, group, visible, defaultVisible: visible, parentKey };
}

const MENUS: api.ClientMenuItem[] = [
  menu("nav.chat", "对话", "main", true),
  menu("nav.workflow", "工作流", "main", true),
  menu("workflow.image", "生图模块", "workflow", true),
  menu("workflow.image.general", "通用生图", "workflow", true, "workflow.image"),
  menu("workflow.image.ecom", "电商生图", "workflow", true, "workflow.image"),
  menu("workflow.image.portrait", "形象照", "workflow", true, "workflow.image"),
  menu("workflow.novel", "小说模块", "workflow", true),
];

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage(menus: api.ClientMenuItem[]) {
  vi.mocked(api.listClientMenus).mockResolvedValue(menus);
  root = createRoot(container);
  await act(async () => {
    root.render(<ClientMenusPage />);
  });
  await flushEffects();
  return container;
}

function rowFor(scope: HTMLElement, key: string): HTMLTableRowElement {
  const code = Array.from(scope.querySelectorAll("code")).find((el) => el.textContent === key);
  const row = code?.closest("tr");
  if (!row) throw new Error(`row missing for ${key}`);
  return row as HTMLTableRowElement;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container.remove();
  vi.clearAllMocks();
});

describe("ClientMenusPage", () => {
  it("生图模块的页内 tab 作为三级菜单渲染在模块行下方", async () => {
    const scope = await renderPage(MENUS);
    expect(scope.textContent).toContain("通用生图");
    expect(scope.textContent).toContain("电商生图");
    expect(scope.textContent).toContain("形象照");
    expect(scope.textContent).toContain("3/3 个页内 tab 已开启");
    // 二级菜单计数只算二级，不把 tab 混进去
    expect(scope.textContent).toContain("2/2 个子菜单已开启");
    expect(rowFor(scope, "workflow.image.ecom").textContent).toContain("页内 tab");
    expect(rowFor(scope, "workflow.image").textContent).toContain("二级菜单");
    expect(scope.textContent).not.toContain("workflow.commerce-long-image");
  });

  it("父级隐藏时 tab 显示随父级隐藏，tab 全关时模块入口标记为隐藏", async () => {
    const scope = await renderPage([
      ...MENUS.slice(0, 2).map((row) => row.key === "nav.workflow" ? { ...row, visible: false } : row),
      ...MENUS.slice(2),
    ]);
    expect(rowFor(scope, "workflow.image.ecom").textContent).toContain("随父级隐藏");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    const allOff = await renderPage(
      MENUS.map((row) => row.parentKey === "workflow.image" ? { ...row, visible: false } : row),
    );
    expect(rowFor(allOff, "workflow.image").textContent).toContain("tab 全关，入口隐藏");
  });

  it("切换 tab 开关按新 key 提交", async () => {
    const scope = await renderPage(MENUS);
    vi.mocked(api.updateClientMenu).mockResolvedValue({
      ...menu("workflow.image.ecom", "电商生图", "workflow", false, "workflow.image"),
      defaultVisible: true,
    });
    const toggle = rowFor(scope, "workflow.image.ecom").querySelector("button");
    if (!toggle) throw new Error("toggle missing");
    await act(async () => {
      toggle.click();
    });
    await flushEffects();
    expect(api.updateClientMenu).toHaveBeenCalledWith("workflow.image.ecom", false);
    expect(rowFor(scope, "workflow.image.ecom").textContent).toContain("隐藏");
  });
});
