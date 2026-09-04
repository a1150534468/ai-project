import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { saveSession } from "../auth.js";
import { KnowledgePage } from "./Knowledge.js";

vi.mock("../api.js", () => ({
  adminListKb: vi.fn(),
  listKbDocs: vi.fn(),
  createKb: vi.fn(),
  updateKb: vi.fn(),
  deleteKb: vi.fn(),
  deleteKbDoc: vi.fn(),
  addKbDoc: vi.fn(),
}));

const ISO = "2026-09-01T08:00:00.000Z";

const KB_A: api.KnowledgeBase = { id: "kb-a", name: "产品文档", createdAt: ISO, updatedAt: ISO };
const KB_B: api.KnowledgeBase = { id: "kb-b", name: "运维手册", createdAt: ISO, updatedAt: ISO };

function doc(overrides: Partial<api.KbDocument> = {}): api.KbDocument {
  return {
    id: "d1",
    kbId: "kb-a",
    name: "指南.md",
    status: "indexed",
    chunkCount: 7,
    sizeBytes: 2048,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

/** 一个宏任务边界把所有挂着的微任务和 React 的活一起放干，不去数「几个 tick」。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(rows: readonly api.KnowledgeBase[] = [KB_A, KB_B]) {
  vi.mocked(api.adminListKb).mockResolvedValue(rows as api.KnowledgeBase[]);
  root = createRoot(container);
  await act(async () => {
    root?.render(<KnowledgePage />);
  });
  await flush();
  return container;
}

function buttonBy(scope: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await flush();
}

/** 库表里那一行。文档表在展开行内部，所以这里只认第一张表。 */
function kbRow(scope: HTMLElement, name: string): HTMLTableRowElement {
  const cell = Array.from(scope.querySelectorAll("table.tbl > tbody > tr > td strong")).find(
    (node) => node.textContent === name,
  );
  const row = cell?.closest("tr");
  if (!row) throw new Error(`找不到库：${name}`);
  return row as HTMLTableRowElement;
}

function docTable(scope: HTMLElement): HTMLTableElement {
  const table = scope.querySelector<HTMLTableElement>("table.tbl.compact");
  if (!table) throw new Error("文档表没画出来");
  return table;
}

function dialog(scope: HTMLElement): HTMLElement {
  const node = scope.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("弹窗没开");
  return node;
}

/** React 在 input 的 value setter 上装了拦截，直接赋值它会当成没变化，得走原生 setter。 */
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
  it("无权限时只有一句话，一个请求都不发", async () => {
    saveSession({ token: "t", adminId: "a2", role: "admin", permissions: [] });
    const scope = await renderPage();

    expect(scope.textContent).toContain("无权限访问此功能");
    expect(api.adminListKb).not.toHaveBeenCalled();
    // 判断在外层做，Hook 全在内层 —— 提前 return 才不会让两次渲染的 Hook 数量对不上
    expect(scope.querySelector("table")).toBeNull();
  });

  it("有权限就拉列表；拉之前不说「暂无」", async () => {
    const scope = await renderPage([]);

    expect(api.adminListKb).toHaveBeenCalledTimes(1);
    expect(scope.textContent).toContain("暂无知识库");
    expect(scope.textContent).not.toContain("正在加载…");
  });
});

describe("展开文档", () => {
  it("文档行是库行的兄弟，同在一个 tbody 里 —— 原来每行又套了一层 tbody", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([doc()]);
    const scope = await renderPage();
    const row = kbRow(scope, "产品文档");

    await click(buttonBy(row, "文档"));

    expect(api.listKbDocs).toHaveBeenCalledWith("kb-a");
    const body = row.parentElement as HTMLElement;
    expect(body.tagName).toBe("TBODY");
    // tbody 的孩子只能是 tr：这一条就是原来那个「tbody 里嵌 tbody」的反面
    expect(Array.from(body.children).map((child) => child.tagName)).toEqual(["TR", "TR", "TR"]);
    const expandedRow = row.nextElementSibling as HTMLTableRowElement;
    expect(expandedRow.querySelector("td")?.colSpan).toBe(4);
    expect(expandedRow.textContent).toContain("文档列表");
    expect(buttonBy(row, "收起").getAttribute("aria-expanded")).toBe("true");
  });

  it("状态按小写值查表，体积换成人话 —— 原来每篇文档都显示「待处理」", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([
      doc({ id: "d1", name: "已好.md", status: "indexed", sizeBytes: 2048 }),
      doc({ id: "d2", name: "在跑.md", status: "indexing", sizeBytes: 1536 }),
      doc({ id: "d3", name: "老值.md", status: "INDEXED", sizeBytes: 1024 * 1024 * 3 }),
      doc({ id: "d4", name: "怪值.md", status: "queued", sizeBytes: 0 }),
    ]);
    const scope = await renderPage();
    await click(buttonBy(kbRow(scope, "产品文档"), "文档"));

    const rows = Array.from(docTable(scope).querySelectorAll("tbody > tr"));
    const pills = rows.map((row) => row.querySelector("span.pill") as HTMLSpanElement);
    // 第三行说明大小写都认，第四行说明名单外的值有话说而不是留个空徽标
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "已建立知识晶格链接",
      "索引中",
      "已建立知识晶格链接",
      "待处理",
    ]);
    expect(pills[0]?.classList.contains("g")).toBe(true);
    expect(pills[1]?.classList.contains("w")).toBe(true);
    expect(pills[3]?.classList.contains("n")).toBe(true);

    const sizes = rows.map((row) => row.querySelectorAll("td.num")[1] as HTMLTableCellElement);
    expect(sizes.map((cell) => cell.textContent)).toEqual(["2 KB", "1.5 KB", "3 MB", "0 B"]);
    // 精确字节数还在，只是挪进了 title
    expect(sizes[0]?.title).toBe("2048 字节");
  });

  it("「刷新」真的会再拉一遍 —— 原来这个回调收下了却没人调", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([doc()]);
    const scope = await renderPage();
    await click(buttonBy(kbRow(scope, "产品文档"), "文档"));
    expect(api.listKbDocs).toHaveBeenCalledTimes(1);

    await click(buttonBy(scope, "刷新"));
    expect(api.listKbDocs).toHaveBeenCalledTimes(2);
  });

  it("收起就把文档收掉，换一行只拉新那行的", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([doc()]);
    const scope = await renderPage();
    const row = kbRow(scope, "产品文档");
    await click(buttonBy(row, "文档"));

    await click(buttonBy(row, "收起"));
    expect(scope.querySelector("table.tbl.compact")).toBeNull();

    await click(buttonBy(kbRow(scope, "运维手册"), "文档"));
    expect(api.listKbDocs).toHaveBeenLastCalledWith("kb-b");
  });
});

describe("新建与改名", () => {
  it("「改名」带着当前名字打开，提交走 updateKb —— 原来这个框是空的", async () => {
    vi.mocked(api.updateKb).mockResolvedValue(undefined);
    const scope = await renderPage();
    await click(buttonBy(kbRow(scope, "产品文档"), "改名"));

    const box = dialog(scope);
    expect(box.getAttribute("aria-label")).toBe("改名");
    const input = box.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("产品文档");

    await type(input, "  产品文档 v2  ");
    await click(buttonBy(box, "保存"));

    // 前后空格在提交前削掉
    expect(api.updateKb).toHaveBeenCalledWith("kb-a", "产品文档 v2");
    expect(api.createKb).not.toHaveBeenCalled();
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
    // 存完重拉一次列表
    expect(api.adminListKb).toHaveBeenCalledTimes(2);
  });

  it("「新建库」打开是空的，只有空格时按钮是灰的，回车即提交", async () => {
    vi.mocked(api.createKb).mockResolvedValue(KB_A);
    const scope = await renderPage();
    await click(buttonBy(scope, "+ 新建库"));

    const box = dialog(scope);
    expect(box.getAttribute("aria-label")).toBe("新建知识库");
    const input = box.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(buttonBy(box, "保存").disabled).toBe(true);

    await type(input, "   ");
    expect(buttonBy(box, "保存").disabled).toBe(true);

    await type(input, "新库");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(api.createKb).toHaveBeenCalledWith("新库");
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("删除", () => {
  it("要先过确认，点「取消」就什么都不做", async () => {
    const scope = await renderPage();
    await click(buttonBy(kbRow(scope, "产品文档"), "删除"));

    const ask = dialog(scope);
    expect(ask.textContent).toContain("「产品文档」");
    await click(buttonBy(ask, "取消"));

    expect(api.deleteKb).not.toHaveBeenCalled();
    expect(scope.querySelector('[role="dialog"]')).toBeNull();
  });

  it("删掉正展开着的那个库，展开态跟着收 —— 否则它一直指着一个不存在的库", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([doc()]);
    vi.mocked(api.deleteKb).mockResolvedValue(undefined);
    const scope = await renderPage();
    const row = kbRow(scope, "产品文档");
    await click(buttonBy(row, "文档"));

    vi.mocked(api.adminListKb).mockResolvedValue([KB_B]);
    await click(buttonBy(row, "删除"));
    await click(buttonBy(dialog(scope), "删除"));

    expect(api.deleteKb).toHaveBeenCalledWith("kb-a");
    expect(scope.querySelector("table.tbl.compact")).toBeNull();
    expect(scope.textContent).not.toContain("产品文档");
  });

  it("删文档拿的是文档自己带的 kbId，删完只重拉当前这一行", async () => {
    vi.mocked(api.listKbDocs).mockResolvedValue([doc({ kbId: "kb-a", name: "指南.md" })]);
    vi.mocked(api.deleteKbDoc).mockResolvedValue(undefined);
    const scope = await renderPage();
    await click(buttonBy(kbRow(scope, "产品文档"), "文档"));

    const remove = Array.from(docTable(scope).querySelectorAll("button")).find(
      (node) => node.getAttribute("aria-label") === "删除文档 指南.md",
    ) as HTMLButtonElement;
    await click(remove);
    await click(buttonBy(dialog(scope), "删除"));

    expect(api.deleteKbDoc).toHaveBeenCalledWith("kb-a", "d1");
    expect(api.listKbDocs).toHaveBeenCalledTimes(2);
    expect(api.adminListKb).toHaveBeenCalledTimes(1);
  });
});
