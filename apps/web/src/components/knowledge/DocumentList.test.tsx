// @vitest-environment jsdom

/**
 * 文档清单。要钉住的是徽标走的是共享的那张状态表（所以名单外的值也有文案），
 * 一列长得一样的「删除」键各自带得出自己删的是哪篇，以及产物链接和错误各自只在有值时出现。
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KbDocument } from "../../kbApi";
import DocumentList from "./DocumentList";

function doc(overrides: Partial<KbDocument> = {}): KbDocument {
  return {
    id: "a",
    name: "a.md",
    status: "indexed",
    sizeBytes: 2048,
    chunkCount: 7,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function mount(documents: readonly KbDocument[], deleting = false) {
  const onDelete = vi.fn();
  render(<DocumentList documents={documents} deleting={deleting} onDelete={onDelete} />);
  return { onDelete };
}

describe("每行的状态与元信息", () => {
  it("状态文案和转不转都由共享的那张表决定", () => {
    mount([doc({ id: "a", status: "indexed" }), doc({ id: "b", status: "indexing" })]);

    expect(screen.getByText("已建立知识晶格链接")).toBeInTheDocument();
    // 徽标本体就是 getByText 命中的那个 <span>，图标是它的孩子
    expect(screen.getByText("索引中").querySelector("[data-icon]")?.className).toContain("animate-spin");
    expect(screen.getByText("已建立知识晶格链接").querySelector("[data-icon]")?.className).not.toContain(
      "animate-spin",
    );
  });

  it("认不出来的状态也有文案 —— 原来这种行的徽标只剩个图标", () => {
    mount([doc({ status: "INDEXED" as KbDocument["status"] })]);

    expect(screen.getByText("待处理")).toBeInTheDocument();
  });

  it("体积、晶格数、日期各占一格", () => {
    mount([doc()]);

    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("已链接晶格数量：7")).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-09-01T00:00:00.000Z").toLocaleDateString("zh-CN"))).toBeInTheDocument();
  });
});

describe("删除键", () => {
  it("名字进 aria-label，两行才分得开", () => {
    const { onDelete } = mount([doc({ id: "a", name: "第一篇.md" }), doc({ id: "b", name: "第二篇.md" })]);

    fireEvent.click(screen.getByRole("button", { name: "删除文档 第二篇.md" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("正在删就整列锁住", () => {
    const { onDelete } = mount([doc()], true);

    const button = screen.getByRole("button", { name: "删除文档 a.md" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("可选的两块", () => {
  it("有 sourceUri 才有「打开产物」，且是新窗口打开", () => {
    mount([doc({ sourceUri: "https://example.com/a.md" })]);

    const link = screen.getByRole("link", { name: "打开产物" });
    expect(link).toHaveAttribute("href", "https://example.com/a.md");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("有 error 才有那条报警，且读屏会打断", () => {
    mount([doc({ status: "failed", error: "解析失败" })]);

    expect(screen.getByRole("alert")).toHaveTextContent("错误: 解析失败");
  });

  it("两个都没有就都不画", () => {
    mount([doc()]);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("一篇都没有时只有一句「暂无文档」", () => {
    mount([]);

    expect(screen.getByText("暂无文档")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
