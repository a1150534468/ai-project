/**
 * App.tsx 的用例：登录页的提交条件、侧栏分组与当前项、权限过滤、窄屏抽屉。
 *
 * 头一条是重写时收掉的老毛病：按钮 `disabled` 只挡得住鼠标，表单的隐式提交
 * （回车）照样会走 onSubmit —— 所以「用户名和密码都不为空」这个条件必须在
 * 处理器里也拦一次。用例直接 `form.requestSubmit()`，走的就是回车那条路。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api.js";
import { App } from "./App.js";
import { loadSession, type Permission, saveSession, type Session } from "./auth.js";

// 页面组件挂载时各自会拉数据，这里把首屏用得到的几个 loader 一起换掉
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  login: vi.fn(),
  listUsers: vi.fn(),
  listAnnouncements: vi.fn(),
  listAdmins: vi.fn(),
  listAudit: vi.fn(),
}));

const EMPTY_USERS: api.AdminUserPage = { rows: [], total: 0, page: 1, pageSize: 20 };

function sessionOf(role: Session["role"], permissions: Permission[] = []): Session {
  return { token: "t", adminId: "a1", role, permissions };
}

let container: HTMLDivElement;
let root: Root | null = null;

/** 一个宏任务边界把挂着的微任务和 React 的活一起放干。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
  });
  await flush();
  return container;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await flush();
}

/** React 在 input 的 value setter 上装了拦截，直接赋值会被当成没变化。 */
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputBy(scope: ParentNode, label: string): HTMLInputElement {
  const node = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!node) throw new Error(`找不到输入框：${label}`);
  return node;
}

function loginForm(scope: ParentNode): HTMLFormElement {
  const form = scope.querySelector<HTMLFormElement>("form.login-form");
  if (!form) throw new Error("登录表单不在");
  return form;
}

function submitButton(scope: ParentNode): HTMLButtonElement {
  const node = scope.querySelector<HTMLButtonElement>('form.login-form button[type="submit"]');
  if (!node) throw new Error("提交键不在");
  return node;
}

function navLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("button.nav-item")).map((node) => node.textContent?.trim() ?? "");
}

function groupLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll(".navgrp-label")).map((node) => node.textContent ?? "");
}

/** 当前项：`.active` 类与 `aria-current` 必须指同一项，两头一起查。 */
function currentNav(scope: ParentNode): string {
  const marked = scope.querySelectorAll('button.nav-item[aria-current="page"]');
  if (marked.length !== 1) throw new Error(`aria-current 应当只有一个，实到 ${marked.length}`);
  const active = scope.querySelectorAll("button.nav-item.active");
  if (active.length !== 1 || active[0] !== marked[0]) throw new Error("active 类与 aria-current 不是同一项");
  return marked[0]?.textContent?.trim() ?? "";
}

function navByLabel(scope: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button.nav-item")).find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`侧栏没有：${label}`);
  return found;
}

function required<T extends Element>(scope: ParentNode, selector: string): T {
  const node = scope.querySelector<T>(selector);
  if (!node) throw new Error(`找不到：${selector}`);
  return node;
}
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(api.listUsers).mockResolvedValue(EMPTY_USERS);
  vi.mocked(api.listAnnouncements).mockResolvedValue([]);
  vi.mocked(api.listAdmins).mockResolvedValue([]);
  vi.mocked(api.listAudit).mockResolvedValue([]);
});

afterEach(async () => {
  if (root) {
    const dying = root;
    await act(async () => {
      dying.unmount();
    });
    root = null;
  }
  container.remove();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("登录", () => {
  it("填不全时回车也发不出请求 —— 按钮禁用只挡得住鼠标", async () => {
    const scope = await render();
    expect(submitButton(scope).disabled).toBe(true);

    await type(inputBy(scope, "管理员用户名"), "admin");
    expect(submitButton(scope).disabled).toBe(true);
    await act(async () => {
      loginForm(scope).requestSubmit();
    });
    await flush();
    expect(api.login).not.toHaveBeenCalled();

    await type(inputBy(scope, "密码"), "pw");
    expect(submitButton(scope).disabled).toBe(false);
  });

  it("密码框是 password 类型，两个框都有可访问名", async () => {
    const scope = await render();
    expect(inputBy(scope, "密码").type).toBe("password");
    expect(inputBy(scope, "管理员用户名").getAttribute("autocomplete")).toBe("username");
  });
  it("登录成功：会话落盘，整棵树换成外壳", async () => {
    vi.mocked(api.login).mockResolvedValue(sessionOf("super_admin"));
    const scope = await render();
    await type(inputBy(scope, "管理员用户名"), "admin");
    await type(inputBy(scope, "密码"), "pw");
    await click(submitButton(scope));

    expect(api.login).toHaveBeenCalledWith("admin", "pw");
    expect(loadSession()?.adminId).toBe("a1");
    expect(scope.querySelector("form.login-form")).toBeNull();
    expect(navLabels(scope)).toContain("用户");
  });

  it("登录失败：留在登录页，输入框解禁能再试一次", async () => {
    vi.mocked(api.login).mockRejectedValue(new Error("用户名或密码错误"));
    const scope = await render();
    await type(inputBy(scope, "管理员用户名"), "admin");
    await type(inputBy(scope, "密码"), "pw");
    await click(submitButton(scope));

    expect(scope.textContent).toContain("用户名或密码错误");
    expect(loadSession()).toBeNull();
    expect(inputBy(scope, "密码").disabled).toBe(false);
    expect(submitButton(scope).disabled).toBe(false);
  });
});
describe("外壳", () => {
  it("侧栏按组名归组，当前项的类名与 aria-current 一致", async () => {
    saveSession(sessionOf("super_admin"));
    const scope = await render();

    expect(groupLabels(scope)).toEqual(["运营", "配置", "系统"]);
    expect(navLabels(scope)).toEqual(["用户", "公告", "官方知识库", "用户端菜单", "管理员", "审计"]);
    expect(currentNav(scope)).toBe("用户");
    expect(required(scope, ".top-title").textContent).toBe("用户");
    expect(required(scope, ".breadcrumb-group").textContent).toBe("运营");
    expect(required(scope, ".breadcrumb-page").textContent).toBe("用户");
  });

  it("切 tab：正文、面包屑、当前项一起跟着走", async () => {
    saveSession(sessionOf("super_admin"));
    const scope = await render();
    await click(navByLabel(scope, "审计"));

    expect(api.listAudit).toHaveBeenCalledWith(200);
    expect(currentNav(scope)).toBe("审计");
    expect(required(scope, ".breadcrumb-group").textContent).toBe("系统");
    expect(required(scope, ".top-title").textContent).toBe("审计");
  });

  it("按权限裁 tab：只授了公告，就只有那一项、也只发那一个请求", async () => {
    saveSession(sessionOf("admin", ["ANNOUNCEMENT_MANAGE"]));
    const scope = await render();

    expect(navLabels(scope)).toEqual(["公告"]);
    expect(api.listAnnouncements).toHaveBeenCalledTimes(1);
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(required(scope, ".profile-name").textContent).toBe("管理员");
  });

  it("一条权限都没有：不渲染 tab，正文给一句说明", async () => {
    saveSession(sessionOf("admin"));
    const scope = await render();

    expect(navLabels(scope)).toEqual([]);
    expect(required(scope, ".top-title").textContent).toBe("未选择");
    expect(scope.textContent).toContain("无可用功能");
    expect(scope.querySelector(".top-breadcrumbs")).toBeNull();
  });

  it("登出清掉会话，回到登录页", async () => {
    saveSession(sessionOf("super_admin"));
    const scope = await render();
    await click(required<HTMLButtonElement>(scope, "button.profile-logout"));

    expect(loadSession()).toBeNull();
    expect(scope.querySelector("form.login-form")).not.toBeNull();
  });
});
describe("窄屏抽屉", () => {
  it("汉堡键开合抽屉，Esc 也收得掉 —— 原来只能点遮罩", async () => {
    saveSession(sessionOf("super_admin"));
    const scope = await render();
    const hamburger = required<HTMLButtonElement>(scope, "button.hamburger");

    expect(hamburger.getAttribute("aria-controls")).toBe("admin-nav");
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(scope.querySelector(".sidebar-backdrop")).toBeNull();

    await click(hamburger);
    expect(required(scope, "aside").className).toBe("side open");
    expect(hamburger.getAttribute("aria-expanded")).toBe("true");
    expect(scope.querySelector(".sidebar-backdrop")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(required(scope, "aside").className).toBe("side");
    expect(scope.querySelector(".sidebar-backdrop")).toBeNull();
  });

  it("点侧栏里的项顺手把抽屉收起来", async () => {
    saveSession(sessionOf("super_admin"));
    const scope = await render();
    await click(required<HTMLButtonElement>(scope, "button.hamburger"));
    await click(navByLabel(scope, "公告"));

    expect(required(scope, "aside").className).toBe("side");
    expect(currentNav(scope)).toBe("公告");
  });
});
