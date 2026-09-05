/**
 * Admins.tsx 的用例。两处是重写时收掉的老毛病，用例专门盯着：
 * 1. 可勾选的权限原来是页面里手抄的三条，漏了 `KNOWLEDGE_MANAGE` —— 服务端收这一条，
 *    后台却勾不出来。现在名单从 auth.ts 的目录出，所以这里核对的是「四条、且含知识库管理」。
 * 2. 权限门禁写在 useState 之前。用例从无权限的账号渲染一遍，确认那条分支不拿 hook、
 *    也不发请求。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { saveSession } from "../auth.js";
import { AdminsPage } from "./Admins.js";

vi.mock("../api.js", () => ({
  listAdmins: vi.fn(),
  createAdminAccount: vi.fn(),
  updateAdminAccount: vi.fn(),
}));

const ISO = "2026-09-01T08:00:00.000Z";

function adminRow(overrides: Partial<api.AdminRow> = {}): api.AdminRow {
  return {
    id: "ad1",
    username: "ops",
    role: "admin",
    permissions: [],
    disabled: false,
    createdAt: ISO,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(rows: readonly api.AdminRow[]) {
  vi.mocked(api.listAdmins).mockResolvedValue(rows as api.AdminRow[]);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AdminsPage />);
  });
  await flush();
  return container;
}
async function click(node: HTMLElement | null | undefined) {
  if (!node) throw new Error("要点的元素不在");
  await act(async () => {
    node.click();
  });
  await flush();
}

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

async function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error("输入框不在");
  await act(async () => {
    nativeValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonBy(scope: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === text,
  );
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

function dialog(scope: ParentNode): HTMLElement {
  const node = scope.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("弹窗没开");
  return node;
}

function rowFor(scope: ParentNode, username: string): HTMLTableRowElement {
  const found = Array.from(scope.querySelectorAll<HTMLTableRowElement>("tbody tr")).find(
    (node) => node.querySelector("td")?.textContent === username,
  );
  if (!found) throw new Error(`找不到这一行：${username}`);
  return found;
}

/** 勾选框那一列：文案按目录顺序排。 */
function permLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("label.check-line")).map((node) => node.textContent ?? "");
}

function checkboxFor(scope: ParentNode, label: string): HTMLInputElement {
  const line = Array.from(scope.querySelectorAll("label.check-line")).find((node) => node.textContent === label);
  const box = line?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`找不到勾选框：${label}`);
  return box;
}
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  saveSession({ token: "t", adminId: "a1", role: "super_admin", permissions: [] });
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

describe("权限闸", () => {
  it("没有 ADMIN_MANAGE：只有一句话，一个请求都不发", async () => {
    saveSession({ token: "t", adminId: "a2", role: "admin", permissions: ["USER_MANAGE"] });
    const scope = await renderPage([]);

    expect(scope.textContent).toContain("无权限访问此功能");
    expect(api.listAdmins).not.toHaveBeenCalled();
    expect(scope.querySelector("table")).toBeNull();
  });
});

describe("列表", () => {
  it("权限列：超管一句话盖过明细，普通管理员列中文名，空的给破折号", async () => {
    const scope = await renderPage([
      adminRow({ id: "s", username: "root", role: "super_admin", permissions: ["USER_MANAGE"] }),
      adminRow({ id: "a", username: "ops", permissions: ["USER_MANAGE", "KNOWLEDGE_MANAGE"] }),
      adminRow({ id: "b", username: "bare", permissions: [] }),
    ]);

    expect(rowFor(scope, "root").querySelectorAll("td")[2]?.textContent).toBe("全部权限");
    expect(rowFor(scope, "ops").querySelectorAll("td")[2]?.textContent).toBe("用户管理, 知识库管理");
    expect(rowFor(scope, "bare").querySelectorAll("td")[2]?.textContent).toBe("—");
    // 超管那行不摆禁用键：服务端也会拒
    expect(rowFor(scope, "root").querySelector("td:last-child button")).toBeNull();
    expect(rowFor(scope, "ops").querySelector("td:last-child button")?.textContent).toBe("禁用");
  });

  it("首帧不摆「暂无管理员」", async () => {
    let settle: (rows: api.AdminRow[]) => void = () => {};
    vi.mocked(api.listAdmins).mockReturnValue(
      new Promise<api.AdminRow[]>((resolve) => {
        settle = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root?.render(<AdminsPage />);
    });

    expect(container.textContent).not.toContain("暂无管理员");
    await act(async () => {
      settle([]);
    });
    await flush();
    expect(container.textContent).toContain("暂无管理员");
  });
  it("禁用要先确认；确认后提交并重拉列表", async () => {
    const scope = await renderPage([adminRow({ username: "ops" })]);
    vi.mocked(api.updateAdminAccount).mockResolvedValue(undefined);

    await click(rowFor(scope, "ops").querySelector<HTMLButtonElement>("td:last-child button"));
    expect(dialog(scope).textContent).toContain('确认禁用管理员"ops"？');
    expect(api.updateAdminAccount).not.toHaveBeenCalled();

    vi.mocked(api.listAdmins).mockResolvedValue([adminRow({ username: "ops", disabled: true })]);
    await click(buttonBy(dialog(scope), "禁用"));

    expect(api.updateAdminAccount).toHaveBeenCalledWith("ad1", { disabled: true });
    expect(api.listAdmins).toHaveBeenCalledTimes(2);
    expect(rowFor(scope, "ops").querySelectorAll("td")[3]?.textContent).toBe("禁用");
  });

  it("确认框点取消：什么都不发", async () => {
    const scope = await renderPage([adminRow({ username: "ops" })]);

    await click(rowFor(scope, "ops").querySelector<HTMLButtonElement>("td:last-child button"));
    await click(buttonBy(dialog(scope), "取消"));

    expect(api.updateAdminAccount).not.toHaveBeenCalled();
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
  });
});
describe("创建管理员", () => {
  async function openCreate() {
    const scope = await renderPage([]);
    await click(buttonBy(scope, "创建管理员"));
    return scope;
  }

  it("可勾选的四条来自权限目录，含知识库管理、不含管理员管理", async () => {
    const scope = await openCreate();

    expect(permLabels(dialog(scope))).toEqual(["用户管理", "用户完整详情", "公告管理", "知识库管理"]);
    expect(permLabels(dialog(scope))).not.toContain("管理员管理");
  });

  it("用户名 <3 或密码 <8 时提交键禁用", async () => {
    const scope = await openCreate();
    const create = buttonBy(dialog(scope), "创建");
    const [username, password] = Array.from(dialog(scope).querySelectorAll<HTMLInputElement>("input:not([type=checkbox])"));

    expect(create.disabled).toBe(true);
    await type(username, "ab");
    await type(password, "12345678");
    expect(create.disabled).toBe(true);

    await type(username, "abc");
    expect(create.disabled).toBe(false);
    await type(password, "1234567");
    expect(create.disabled).toBe(true);
  });

  it("页脚的提交键靠 form= 关联正文表单 —— Modal 的页脚是正文的兄弟节点", async () => {
    const scope = await openCreate();
    const create = buttonBy(dialog(scope), "创建");

    expect(create.getAttribute("form")).toBe("admin-create");
    expect(create.form).toBe(dialog(scope).querySelector("form#admin-create"));
  });

  it("提交：密码原样发，权限按目录顺序发，不跟着勾选先后", async () => {
    const scope = await openCreate();
    vi.mocked(api.createAdminAccount).mockResolvedValue(undefined);
    const [username, password] = Array.from(dialog(scope).querySelectorAll<HTMLInputElement>("input:not([type=checkbox])"));

    await type(username, " ops2 ");
    await type(password, "longenough");
    // 先勾后面那条，再勾前面那条
    await click(checkboxFor(dialog(scope), "知识库管理"));
    await click(checkboxFor(dialog(scope), "用户管理"));
    await click(buttonBy(dialog(scope), "创建"));

    expect(api.createAdminAccount).toHaveBeenCalledWith({
      username: "ops2",
      password: "longenough",
      permissions: ["USER_MANAGE", "KNOWLEDGE_MANAGE"],
    });
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
    expect(scope.textContent).toContain("已创建");
  });

  it("勾了再点一次就取消勾选", async () => {
    const scope = await openCreate();
    const box = checkboxFor(dialog(scope), "公告管理");

    await click(box);
    expect(checkboxFor(dialog(scope), "公告管理").checked).toBe(true);
    await click(checkboxFor(dialog(scope), "公告管理"));
    expect(checkboxFor(dialog(scope), "公告管理").checked).toBe(false);
    expect(box.isConnected).toBe(true);
  });

  it("创建失败：弹窗留着，错误报到 toast", async () => {
    const scope = await openCreate();
    vi.mocked(api.createAdminAccount).mockRejectedValue(new Error("用户名已存在"));
    const [username, password] = Array.from(dialog(scope).querySelectorAll<HTMLInputElement>("input:not([type=checkbox])"));

    await type(username, "dup");
    await type(password, "longenough");
    await click(buttonBy(dialog(scope), "创建"));

    expect(scope.textContent).toContain("用户名已存在");
    expect(scope.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
