/**
 * Users.tsx 与它的详情弹窗的用例。盯着重写时收掉的这几处：
 * 1. 「初始密码」原来没有 `type="password"`，建号时明文摆在页面上；
 * 2. 首屏那一瞬表格里就摆着「无数据」；
 * 3. 页码越界（翻页期间数据被删）要退回末页，再取一次；
 * 4. 翻页用的是已提交的搜索词，不是输入框里那半句话；
 * 5. 详情弹窗原来把 `onError` 收进 effect 依赖 —— 父组件一渲染就重新拉一次详情；
 * 6. 时间线原来在 80 条上再切 16 条，剩下的无声丢掉。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { saveSession, type Permission } from "../auth.js";
import { UsersPage } from "./Users.js";

vi.mock("../api.js", () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  getUserDetail: vi.fn(),
}));

const ISO = "2026-09-01T08:00:00.000Z";

function userRow(overrides: Partial<api.AdminUser> = {}): api.AdminUser {
  return { id: "u1", uid: "10001", username: "alice", bannedAt: null, createdAt: ISO, ...overrides };
}

function pageOf(rows: readonly api.AdminUser[], total = rows.length, page = 1): api.AdminUserPage {
  return { rows: rows as api.AdminUser[], total, page, pageSize: 20 };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(first: api.AdminUserPage = pageOf([userRow()])) {
  vi.mocked(api.listUsers).mockResolvedValue(first);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UsersPage />);
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

function inputBy(scope: ParentNode, label: string): HTMLInputElement {
  const node = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!node) throw new Error(`找不到输入框：${label}`);
  return node;
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

function login(permissions: Permission[]) {
  saveSession({ token: "t", adminId: "a1", role: "admin", permissions });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  login(["USER_MANAGE", "USER_DETAIL_VIEW"]);
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
describe("取数与翻页", () => {
  it("首帧不摆「无数据」，拉完是空的才摆", async () => {
    let settle: (data: api.AdminUserPage) => void = () => {};
    vi.mocked(api.listUsers).mockReturnValue(
      new Promise<api.AdminUserPage>((resolve) => {
        settle = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root?.render(<UsersPage />);
    });

    expect(container.textContent).not.toContain("无数据");
    expect(buttonBy(container, "加载中…").disabled).toBe(true);

    await act(async () => {
      settle(pageOf([], 0));
    });
    await flush();
    expect(container.textContent).toContain("无数据");
  });

  it("翻页带的是已提交的词，不是输入框里那半句话", async () => {
    const scope = await renderPage(pageOf([userRow()], 61));
    await type(inputBy(scope, "按 UID / 用户名搜索"), "张");

    await click(buttonBy(scope, "下一页"));
    expect(api.listUsers).toHaveBeenLastCalledWith(undefined, 2, 20);

    await click(buttonBy(scope, "搜索"));
    expect(api.listUsers).toHaveBeenLastCalledWith("张", 1, 20);
  });

  it("页码越界就退回末页再取一次", async () => {
    let total = 61;
    vi.mocked(api.listUsers).mockImplementation(async (_q, page = 1) => {
      if (page > Math.ceil(total / 20)) return pageOf([], total, page);
      return pageOf([userRow({ id: `u${page}`, uid: `1000${page}` })], total, page);
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(<UsersPage />);
    });
    await flush();

    // 翻到第 2 页时别人把用户删到只剩 21 个，界面上的总页数还是 4
    await click(buttonBy(container, "下一页"));
    total = 21;
    await click(buttonBy(container, "下一页"));

    expect(vi.mocked(api.listUsers).mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 2]);
    expect(container.textContent).toContain("第 2 / 2 页 · 共 21 人");
  });
});
describe("封禁与建号", () => {
  it("封禁先确认，文案带用户名和 uid；确认后重拉列表", async () => {
    const scope = await renderPage(pageOf([userRow()]));
    vi.mocked(api.banUser).mockResolvedValue(undefined);

    await click(buttonBy(scope, "封禁"));
    expect(dialog(scope).textContent).toContain("确认封禁用户 alice(10001)?");
    expect(api.banUser).not.toHaveBeenCalled();

    vi.mocked(api.listUsers).mockResolvedValue(pageOf([userRow({ bannedAt: ISO })]));
    await click(buttonBy(dialog(scope), "封禁"));

    expect(api.banUser).toHaveBeenCalledWith("u1");
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(scope.textContent).toContain("已封禁");
  });

  it("已封禁的那行走解封；点取消什么都不发", async () => {
    const scope = await renderPage(pageOf([userRow({ bannedAt: ISO })]));

    await click(buttonBy(scope, "解封"));
    await click(buttonBy(dialog(scope), "取消"));
    expect(api.unbanUser).not.toHaveBeenCalled();

    vi.mocked(api.unbanUser).mockResolvedValue(undefined);
    await click(buttonBy(scope, "解封"));
    await click(buttonBy(dialog(scope), "解封"));
    expect(api.unbanUser).toHaveBeenCalledWith("u1");
  });

  it("只有查看详情权限时，不摆封禁键也不摆建号键", async () => {
    login(["USER_DETAIL_VIEW"]);
    const scope = await renderPage(pageOf([userRow()]));

    expect(scope.textContent).not.toContain("封禁");
    expect(scope.textContent).not.toContain("+ 建用户");
    expect(buttonBy(scope, "详情")).toBeTruthy();
  });

  it("初始密码是 password 类型；用户名 <3 或密码 <8 时提交键禁用", async () => {
    const scope = await renderPage(pageOf([userRow()]));
    await click(buttonBy(scope, "+ 建用户"));

    const password = inputBy(scope, "初始密码(≥8)");
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");

    expect(buttonBy(scope, "提交").disabled).toBe(true);
    await type(inputBy(scope, "用户名(≥3)"), "ab");
    await type(password, "12345678");
    expect(buttonBy(scope, "提交").disabled).toBe(true);

    await type(inputBy(scope, "用户名(≥3)"), "abc");
    expect(buttonBy(scope, "提交").disabled).toBe(false);
  });

  it("建号成功：表单收起、列表重拉", async () => {
    const scope = await renderPage(pageOf([userRow()]));
    vi.mocked(api.createUser).mockResolvedValue(undefined);
    await click(buttonBy(scope, "+ 建用户"));
    await type(inputBy(scope, "用户名(≥3)"), "bob");
    await type(inputBy(scope, "初始密码(≥8)"), "longenough");
    await click(buttonBy(scope, "提交"));

    expect(api.createUser).toHaveBeenCalledWith("bob", "longenough");
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(scope.textContent).toContain("已创建");
    expect(buttonBy(scope, "+ 建用户")).toBeTruthy();
  });
});
describe("详情弹窗", () => {
  function timelineItem(type: string, title: string, at = ISO): api.UserTimelineItem {
    return { type, title, at, meta: "" };
  }

  function detailOf(timeline: readonly api.UserTimelineItem[]): api.UserDetail {
    return {
      user: userRow(),
      kpis: { loginCountToday: 3, todayAgent: 1 },
      activity: [
        { key: "today", sessions: 1, messages: 2, agents: 0, knowledgeBases: 0, kbDocuments: 0, imageTasks: 0 },
        { key: "total", sessions: 9, messages: 8, agents: 7, knowledgeBases: 6, kbDocuments: 5, imageTasks: 4 },
      ],
      timeline: timeline as api.UserTimelineItem[],
    };
  }

  async function openDetail(detail: api.UserDetail) {
    const scope = await renderPage(pageOf([userRow()]));
    vi.mocked(api.getUserDetail).mockResolvedValue(detail);
    await click(buttonBy(scope, "详情"));
    return scope;
  }

  it("服务端给多少条就渲染多少条，条数写在小标题上", async () => {
    const items = Array.from({ length: 20 }, (_, index) => timelineItem("session", `第 ${index} 条`));
    const scope = await openDetail(detailOf(items));

    expect(api.getUserDetail).toHaveBeenCalledWith("u1");
    expect(dialog(scope).textContent).toContain("用户时间线（20 条）");
    expect(dialog(scope).querySelectorAll(".timeline-item")).toHaveLength(20);
    expect(dialog(scope).textContent).toContain("用户详情 - alice");
  });

  it("事件类型给中文，认不出的原样显示；活跃度维度同理", async () => {
    const scope = await openDetail(
      detailOf([
        timelineItem("session", "s"),
        timelineItem("message", "m"),
        timelineItem("agent", "a"),
        timelineItem("kb", "k"),
        timelineItem("image", "i"),
        timelineItem("telepathy", "t"),
      ]),
    );
    const types = Array.from(dialog(scope).querySelectorAll(".timeline-item strong")).map((n) => n.textContent);

    expect(types).toEqual(["会话", "消息", "Agent", "知识库", "生图", "telepathy"]);
    expect(Array.from(dialog(scope).querySelectorAll("table.compact tbody td:first-child")).map((n) => n.textContent))
      .toEqual(["今日", "累计"]);
  });

  it("长标题折起来，消息类的展开键文案单独一档", async () => {
    const long = "话".repeat(200);
    const scope = await openDetail(detailOf([timelineItem("message", long), timelineItem("session", "短的")]));

    const items = dialog(scope).querySelectorAll(".timeline-item");
    expect(items[0]?.querySelector(".timeline-title-text")?.textContent).toBe(`${long.slice(0, 120)}...`);
    expect(items[1]?.querySelector("button")).toBeNull();

    await click(items[0]?.querySelector<HTMLButtonElement>("button.timeline-toggle"));
    const opened = dialog(scope).querySelectorAll(".timeline-item")[0];
    expect(opened?.querySelector(".timeline-title-text")?.textContent).toBe(long);
    expect(opened?.querySelector("button")?.textContent).toBe("收起");
  });

  it("父组件重渲染不会再拉一次详情 —— 原来 onError 闭包进了依赖", async () => {
    const scope = await openDetail(detailOf([timelineItem("session", "s")]));

    await type(inputBy(scope, "按 UID / 用户名搜索"), "随便打点字");
    await type(inputBy(scope, "按 UID / 用户名搜索"), "再打点");

    expect(api.getUserDetail).toHaveBeenCalledTimes(1);
  });

  it("拉详情失败：在弹窗里说，并给一个重试键", async () => {
    const scope = await renderPage(pageOf([userRow()]));
    vi.mocked(api.getUserDetail).mockRejectedValue(new Error("详情服务挂了"));
    await click(buttonBy(scope, "详情"));

    expect(dialog(scope).textContent).toContain("加载失败：详情服务挂了");

    vi.mocked(api.getUserDetail).mockResolvedValue(detailOf([timelineItem("session", "回来了")]));
    await click(buttonBy(dialog(scope), "重试"));

    expect(api.getUserDetail).toHaveBeenCalledTimes(2);
    expect(dialog(scope).textContent).toContain("回来了");
  });
});
