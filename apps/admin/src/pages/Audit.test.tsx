/**
 * Audit.tsx 的用例。重点是动作码那张表：
 * 上一版按 `create` / `update` / `login` 这类小写词去查，而服务端写进库的是
 * `USER_BAN` / `KB_DOC_CREATE` 这种大写码 —— 每一行都落到 fallback 上。
 * 所以这里把服务端真正会写的动作码摆齐，逐条核对中文名与徽标档位。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { saveSession } from "../auth.js";
import { AuditPage } from "./Audit.js";

vi.mock("../api.js", () => ({
  listAudit: vi.fn(),
}));

const ISO = "2026-09-01T08:00:00.000Z";

function auditRow(overrides: Partial<api.AuditRow> = {}): api.AuditRow {
  return { id: "r1", adminId: "adm_1", action: "USER_BAN", target: "u1", detail: null, createdAt: ISO, ...overrides };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(rows: readonly api.AuditRow[]) {
  vi.mocked(api.listAudit).mockResolvedValue(rows as api.AuditRow[]);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AuditPage />);
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
function bodyRows(scope: ParentNode): HTMLTableRowElement[] {
  return Array.from(scope.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

/** 每行的动作徽标：文案 + 档位（`pill` 之外剩下的那个类名）。 */
function pills(scope: ParentNode): { label: string; kind: string }[] {
  return Array.from(scope.querySelectorAll("tbody .pill")).map((node) => ({
    label: node.textContent ?? "",
    kind: node.className.split(/\s+/).filter((name) => name !== "pill").join(" "),
  }));
}

/** 第 n 行的「详情」格 —— 表头是 时间 / 操作 / 管理员 / 目标 / 详情。 */
function detailCell(scope: ParentNode, index: number): HTMLTableCellElement {
  const cell = bodyRows(scope)[index]?.querySelectorAll("td")[4];
  if (!cell) throw new Error(`第 ${index} 行没有详情格`);
  return cell as HTMLTableCellElement;
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
    expect(api.listAudit).not.toHaveBeenCalled();
    // 判断在外层、hook 全在内层，提前 return 才不会让两次渲染的 hook 数量对不上
    expect(scope.querySelector("table")).toBeNull();
  });
});

describe("动作码", () => {
  it("按「对象_动作」两段翻译，认不出的原样显示", async () => {
    const scope = await renderPage([
      auditRow({ id: "1", action: "USER_CREATE" }),
      auditRow({ id: "2", action: "USER_BAN" }),
      auditRow({ id: "3", action: "USER_UNBAN" }),
      auditRow({ id: "4", action: "KB_DOC_CREATE" }),
      auditRow({ id: "5", action: "KB_DELETE" }),
      auditRow({ id: "6", action: "ANNOUNCEMENT_UPDATE" }),
      auditRow({ id: "7", action: "CLIENT_MENU_VISIBILITY_UPDATE" }),
      auditRow({ id: "8", action: "ADMIN_CREATE" }),
      // 两段里有一段不认识 / 压根拆不开：都走原样显示
      auditRow({ id: "9", action: "USER_TELEPORT" }),
      auditRow({ id: "10", action: "LOGIN" }),
    ]);

    expect(pills(scope)).toEqual([
      { label: "新建用户", kind: "g" },
      { label: "封禁用户", kind: "b" },
      { label: "解封用户", kind: "g" },
      { label: "新建知识库文档", kind: "g" },
      { label: "删除知识库", kind: "b" },
      { label: "更新公告", kind: "w" },
      { label: "更新用户端菜单", kind: "w" },
      { label: "新建管理员", kind: "g" },
      { label: "USER_TELEPORT", kind: "n" },
      { label: "LOGIN", kind: "n" },
    ]);
  });
});
describe("详情列", () => {
  const long = { note: "x".repeat(90) };

  it("短的直接摊开，长的给展开键 —— 上一版没有 setter，永远截在 50 个字符", async () => {
    const scope = await renderPage([auditRow({ id: "1", detail: { ok: 1 } }), auditRow({ id: "2", detail: long })]);

    expect(detailCell(scope, 0).querySelector("code")?.textContent).toBe('{"ok":1}');
    expect(detailCell(scope, 0).querySelector("button")).toBeNull();

    const brief = JSON.stringify(long).slice(0, 50);
    expect(detailCell(scope, 1).querySelector("button")?.textContent).toBe(`${brief}...`);
    expect(detailCell(scope, 1).querySelector("pre")).toBeNull();
  });

  it("点摘要展开整段，再点收起", async () => {
    const scope = await renderPage([auditRow({ id: "2", detail: long })]);

    await click(detailCell(scope, 0).querySelector("button"));
    expect(detailCell(scope, 0).querySelector("pre")?.textContent).toBe(JSON.stringify(long, null, 2));
    expect(detailCell(scope, 0).querySelector("button")?.textContent).toBe("收起");

    await click(detailCell(scope, 0).querySelector("button"));
    expect(detailCell(scope, 0).querySelector("pre")).toBeNull();
  });

  it("detail 与 target 缺省都显示破折号", async () => {
    const scope = await renderPage([auditRow({ detail: null, target: null })]);
    const cells = bodyRows(scope)[0]?.querySelectorAll("td");

    expect(cells?.[3]?.textContent).toBe("—");
    expect(cells?.[4]?.textContent).toBe("—");
  });
});

describe("拉取", () => {
  it("一次按服务端上限拉 200 条", async () => {
    await renderPage([]);
    expect(api.listAudit).toHaveBeenCalledWith(200);
  });

  it("首帧不摆「暂无审计日志」，拉完是空的才摆", async () => {
    let settle: (rows: api.AuditRow[]) => void = () => {};
    vi.mocked(api.listAudit).mockReturnValue(
      new Promise<api.AuditRow[]>((resolve) => {
        settle = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root?.render(<AuditPage />);
    });

    expect(container.textContent).toContain("审计日志");
    expect(container.textContent).not.toContain("暂无审计日志");

    await act(async () => {
      settle([]);
    });
    await flush();
    expect(container.textContent).toContain("暂无审计日志");
  });

  it("拉失败：报到 toast，表还在", async () => {
    vi.mocked(api.listAudit).mockRejectedValue(new Error("服务端开小差"));
    root = createRoot(container);
    await act(async () => {
      root?.render(<AuditPage />);
    });
    await flush();

    expect(container.textContent).toContain("服务端开小差");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(bodyRows(container)).toHaveLength(1);
  });
});
