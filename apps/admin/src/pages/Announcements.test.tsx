/**
 * Announcements.tsx 的用例。盯着重写时收掉的这几处：
 * 1. 首屏那一瞬就摆着「暂无公告」；
 * 2. 停用/启用与删除原来各带一份内联的错误处理，现在两条都走页面里的命名函数；
 * 3. 标题与正文没 trim —— 敲一串空格能过 `!title`，发出去是一条空白公告；
 * 4. 页脚的提交键靠 `form=` 关联正文表单（Modal 的页脚是正文的兄弟节点）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { AnnouncementsPage } from "./Announcements.js";

vi.mock("../api.js", () => ({
  listAnnouncements: vi.fn(),
  createAnnouncement: vi.fn(),
  updateAnnouncement: vi.fn(),
  deleteAnnouncement: vi.fn(),
}));

const ISO = "2026-09-01T08:00:00.000Z";

function announcement(overrides: Partial<api.Announcement> = {}): api.Announcement {
  return {
    id: "an1",
    title: "停机通知",
    body: "今晚维护",
    active: true,
    startAt: null,
    endAt: null,
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

async function renderPage(rows: readonly api.Announcement[]) {
  vi.mocked(api.listAnnouncements).mockResolvedValue(rows as api.Announcement[]);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AnnouncementsPage />);
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
const nativeTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

async function type(node: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!node) throw new Error("输入框不在");
  const setter = node instanceof HTMLTextAreaElement ? nativeTextareaValue : nativeValue;
  await act(async () => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
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

function rowFor(scope: ParentNode, title: string): HTMLTableRowElement {
  const found = Array.from(scope.querySelectorAll<HTMLTableRowElement>("tbody tr")).find(
    (node) => node.querySelector("td")?.textContent === title,
  );
  if (!found) throw new Error(`找不到这一行：${title}`);
  return found;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
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
  vi.clearAllMocks();
});
describe("列表", () => {
  it("首帧不摆「暂无公告」，拉完是空的才摆", async () => {
    let settle: (rows: api.Announcement[]) => void = () => {};
    vi.mocked(api.listAnnouncements).mockReturnValue(
      new Promise<api.Announcement[]>((resolve) => {
        settle = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root?.render(<AnnouncementsPage />);
    });

    expect(container.textContent).not.toContain("暂无公告");
    await act(async () => {
      settle([]);
    });
    await flush();
    expect(container.textContent).toContain("暂无公告");
  });

  it("状态徽标与行内动作跟着 active 走", async () => {
    const scope = await renderPage([announcement(), announcement({ id: "an2", title: "已停的", active: false })]);

    expect(rowFor(scope, "停机通知").querySelector(".pill")?.textContent).toBe("启用");
    expect(rowFor(scope, "停机通知").querySelector(".pill")?.className).toBe("pill g");
    expect(buttonBy(rowFor(scope, "停机通知"), "停用")).toBeTruthy();
    expect(rowFor(scope, "已停的").querySelector(".pill")?.className).toBe("pill n");
    expect(buttonBy(rowFor(scope, "已停的"), "启用")).toBeTruthy();
  });

  it("停用：把取反后的 active 发上去，然后重拉", async () => {
    const scope = await renderPage([announcement()]);
    vi.mocked(api.updateAnnouncement).mockResolvedValue(undefined);
    vi.mocked(api.listAnnouncements).mockResolvedValue([announcement({ active: false })]);

    await click(buttonBy(rowFor(scope, "停机通知"), "停用"));

    expect(api.updateAnnouncement).toHaveBeenCalledWith("an1", { active: false });
    expect(api.listAnnouncements).toHaveBeenCalledTimes(2);
    expect(rowFor(scope, "停机通知").querySelector(".pill")?.textContent).toBe("停用");
  });

  it("删除先确认，文案带标题；点取消什么都不发", async () => {
    const scope = await renderPage([announcement()]);

    await click(buttonBy(rowFor(scope, "停机通知"), "删除"));
    expect(dialog(scope).textContent).toContain('确认删除公告"停机通知"？此操作不可撤销。');
    await click(buttonBy(dialog(scope), "取消"));
    expect(api.deleteAnnouncement).not.toHaveBeenCalled();

    vi.mocked(api.deleteAnnouncement).mockResolvedValue(undefined);
    vi.mocked(api.listAnnouncements).mockResolvedValue([]);
    await click(buttonBy(rowFor(scope, "停机通知"), "删除"));
    await click(buttonBy(dialog(scope), "删除"));

    expect(api.deleteAnnouncement).toHaveBeenCalledWith("an1");
    expect(scope.textContent).toContain("已删除");
  });

  it("动作失败：报到 toast，列表不重拉", async () => {
    const scope = await renderPage([announcement()]);
    vi.mocked(api.updateAnnouncement).mockRejectedValue(new Error("公告不存在"));

    await click(buttonBy(rowFor(scope, "停机通知"), "停用"));

    expect(scope.textContent).toContain("公告不存在");
    expect(api.listAnnouncements).toHaveBeenCalledTimes(1);
  });
});
describe("新增公告", () => {
  /** Field 把标签和控件包在同一个 label 里，所以按标签文案找控件。 */
  function control<T extends HTMLElement>(scope: ParentNode, label: string): T {
    const field = Array.from(scope.querySelectorAll("label.field")).find(
      (node) => node.querySelector("span")?.textContent === label,
    );
    const node = field?.querySelector<T>("input, textarea");
    if (!node) throw new Error(`找不到控件：${label}`);
    return node;
  }

  async function openCreate() {
    const scope = await renderPage([]);
    await click(buttonBy(scope, "新增公告"));
    return scope;
  }

  it("一串空格过不了 —— 上一版拿 `!title` 判，空白公告能发出去", async () => {
    const scope = await openCreate();
    const publish = buttonBy(dialog(scope), "发布");

    expect(publish.disabled).toBe(true);
    await type(control<HTMLInputElement>(dialog(scope), "标题"), "   ");
    await type(control<HTMLTextAreaElement>(dialog(scope), "正文"), " \n ");
    expect(publish.disabled).toBe(true);

    await type(control<HTMLInputElement>(dialog(scope), "标题"), " 停机 ");
    expect(publish.disabled).toBe(true);
    await type(control<HTMLTextAreaElement>(dialog(scope), "正文"), " 今晚维护 ");
    expect(publish.disabled).toBe(false);
  });

  it("页脚的发布键靠 form= 关联正文表单 —— Modal 的页脚是正文的兄弟节点", async () => {
    const scope = await openCreate();
    const publish = buttonBy(dialog(scope), "发布");

    expect(publish.getAttribute("form")).toBe("announcement-create");
    expect(publish.form).toBe(dialog(scope).querySelector("form#announcement-create"));
  });

  it("提交：两头都 trim 过，active 恒为 true；成功后收起弹窗并重拉", async () => {
    const scope = await openCreate();
    vi.mocked(api.createAnnouncement).mockResolvedValue(undefined);
    await type(control<HTMLInputElement>(dialog(scope), "标题"), "  停机通知  ");
    await type(control<HTMLTextAreaElement>(dialog(scope), "正文"), "  今晚维护  ");
    await click(buttonBy(dialog(scope), "发布"));

    expect(api.createAnnouncement).toHaveBeenCalledWith({ title: "停机通知", body: "今晚维护", active: true });
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
    expect(scope.textContent).toContain("已发布");
    expect(api.listAnnouncements).toHaveBeenCalledTimes(2);
  });

  it("发布失败：弹窗留着，填过的字还在，错误报到 toast", async () => {
    const scope = await openCreate();
    vi.mocked(api.createAnnouncement).mockRejectedValue(new Error("标题重复"));
    await type(control<HTMLInputElement>(dialog(scope), "标题"), "停机通知");
    await type(control<HTMLTextAreaElement>(dialog(scope), "正文"), "今晚维护");
    await click(buttonBy(dialog(scope), "发布"));

    expect(scope.textContent).toContain("标题重复");
    expect(scope.querySelector('[role="dialog"]')).not.toBeNull();
    expect(control<HTMLInputElement>(dialog(scope), "标题").value).toBe("停机通知");
  });

  it("点取消关掉弹窗，再开一次是空的", async () => {
    const scope = await openCreate();
    await type(control<HTMLInputElement>(dialog(scope), "标题"), "写了一半");
    await click(buttonBy(dialog(scope), "取消"));
    expect(scope.querySelector('[role="dialog"]')).toBeNull();

    await click(buttonBy(scope, "新增公告"));
    expect(control<HTMLInputElement>(dialog(scope), "标题").value).toBe("");
    expect(api.createAnnouncement).not.toHaveBeenCalled();
  });
});
