// @vitest-environment jsdom
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../motion";
import Shell from "./Shell";

const NAV_COLLAPSED_KEY = "ai-assistant:nav:collapsed";

const baseProps = {
  token: "test-token",
  agents: { presets: [], custom: [] },
  onOpenAgentPicker: vi.fn(),
  onAgentsChanged: vi.fn(),
};

/** Shell 只在这里当静态骨架看：布局与可见性都能从一次 SSR 的产物里读出来。 */
const html = (ui: ReactElement) => renderToStaticMarkup(<ToastProvider>{ui}</ToastProvider>);

const shell = (props: Partial<Parameters<typeof Shell>[0]> = {}) =>
  html(
    <Shell currentView="chat" onViewChange={vi.fn()} {...baseProps} {...props}>
      <div />
    </Shell>,
  );

/** 取包含某段文案的那个 button 的标签内容，好断言它身上的状态属性。按钮不嵌套，切得开。 */
function buttonWith(markup: string, label: string): string {
  const buttons = markup
    .split("<button")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</button>")));
  return buttons.find((chunk) => chunk.includes(label)) ?? "";
}

describe("Shell 骨架", () => {
  beforeEach(() => {
    // 侧边栏默认折叠，而下面几条断言的是展开态才可见的文案，所以显式存一次「不折叠」
    localStorage.clear();
    localStorage.setItem(NAV_COLLAPSED_KEY, "false");
  });

  it("展开态露出品牌区与一级导航", () => {
    const markup = shell();
    expect(markup).toContain("AI 助手");
    expect(markup).toContain("您的全能 AI 助手");
    expect(markup).toContain("素材库");
    expect(markup).toContain("模型广场");
  });

  it("当前视图在导航上标成 aria-current，其余项不标", () => {
    const markup = shell({ currentView: "models" });
    expect(buttonWith(markup, "模型广场")).toContain('aria-current="page"');
    expect(buttonWith(markup, "知识库")).not.toContain("aria-current");
  });

  it("按 menuVisibility 藏掉一级项与工作流子项", () => {
    const markup = shell({ menuVisibility: { "nav.models": false, "workflow.novel": false } });
    expect(markup).not.toContain("模型广场");
    expect(markup).not.toContain("小说模块");
    expect(markup).toContain("生图模块");
  });

  it("只有对话页挂 Agent 栏", () => {
    expect(shell()).toContain("新建 Agent");
    expect(shell({ currentView: "kb" })).not.toContain("新建 Agent");
  });
});

describe("Shell 折叠态", () => {
  beforeEach(() => localStorage.clear());

  it("没存过偏好就默认折叠：只留图标，留一个展开入口", () => {
    const markup = shell();
    expect(markup).not.toContain("您的全能 AI 助手");
    expect(buttonWith(markup, 'aria-label="展开侧边栏"')).toBeTruthy();
  });
});
