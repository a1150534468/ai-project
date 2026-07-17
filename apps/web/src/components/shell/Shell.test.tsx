// @vitest-environment jsdom
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ToastProvider } from "../../motion";
import Shell from "./Shell";

describe("Shell", () => {
  beforeEach(() => {
    // 侧边栏默认态已改为缩进；这些用例断言展开态才可见的品牌/导航/充值文案，
    // 故显式置为展开（存 "false"）后再渲染
    localStorage.clear();
    localStorage.setItem("ai-assistant:nav:collapsed", "false");
  });

  const baseProps = {
    token: "test-token",
    agents: { presets: [], custom: [] },
    onOpenAgentPicker: vi.fn(),
    onAgentsChanged: vi.fn(),
  };

  const renderShell = (ui: ReactElement) =>
    renderToStaticMarkup(<ToastProvider>{ui}</ToastProvider>);

  it("renders the AI Assistant brand in the sidebar", () => {
    const html = renderShell(
      <Shell currentView="chat" onViewChange={vi.fn()} {...baseProps}>
        <div />
      </Shell>,
    );

    expect(html).toContain("AI 助手");
    expect(html).toContain("您的全能 AI 助手");
    expect(html).toContain("AI 视频");
  });

  it("keeps recharge out of primary navigation and on the balance entry", () => {
    const html = renderShell(
      <Shell currentView="chat" onViewChange={vi.fn()} balance={99704} {...baseProps}>
        <div />
      </Shell>,
    );

    expect(html).not.toContain("mdi:wallet-outline");
    expect(html).toContain("aria-label=\"充值算力点\"");
    expect(html).toContain(">充值</span>");
  });

  it("adds model marketplace to primary navigation", () => {
    const html = renderShell(
      <Shell currentView="models" onViewChange={vi.fn()} {...baseProps}>
        <div />
      </Shell>,
    );

    expect(html).toContain("模型广场");
    expect(html).toContain("text-gray-900 font-600");
  });

  it("hides configured main and workflow menu entries", () => {
    const html = renderShell(
      <Shell
        currentView="chat"
        onViewChange={vi.fn()}
        menuVisibility={{ "nav.models": false, "workflow.report": false }}
        {...baseProps}
      >
        <div />
      </Shell>,
    );

    expect(html).not.toContain("模型广场");
    expect(html).not.toContain("AI 智能报告");
    expect(html).toContain("生图模块");
  });
});
