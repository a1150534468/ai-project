import { describe, expect, it } from "vitest";
import {
  articleWorkflowMarkdownFromVisibleText,
  articleWorkflowPreservedBodyMarkdown,
  articleWorkflowVisibleTextFromMarkdown,
  articleWorkflowVisibleTextFromSource,
} from "./index.js";

describe("article-workflow markdown", () => {
  it("extracts visible text from markdown without formatting marks", () => {
    expect(articleWorkflowVisibleTextFromMarkdown([
      "# 主标题",
      "",
      "这是 **加粗** 文本和 `代码`。",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "> 一段引用",
    ].join("\n"))).toBe([
      "主标题",
      "这是 加粗 文本和 代码。",
      "第一项",
      "第二项",
      "一段引用",
    ].join("\n"));
  });

  it("normalizes plain text and markdown sources consistently", () => {
    expect(articleWorkflowVisibleTextFromSource("plain-text", " 第一行 \n\n第二行 ")).toBe("第一行\n第二行");
    expect(articleWorkflowVisibleTextFromSource("markdown", "## 标题\n\n正文")).toBe("标题\n正文");
  });

  it("builds preserved body markdown while removing a duplicated title", () => {
    expect(articleWorkflowPreservedBodyMarkdown({
      format: "plain-text",
      sourceText: "文章标题\n\n第一段\n\n第二段",
      title: "文章标题",
    })).toBe("第一段\n\n第二段");

    expect(articleWorkflowPreservedBodyMarkdown({
      format: "markdown",
      sourceText: "# 文章标题\n\n第一段\n\n- 第二段",
      title: "文章标题",
    })).toBe("第一段\n\n- 第二段");
  });

  it("creates simple markdown paragraphs from visible text", () => {
    expect(articleWorkflowMarkdownFromVisibleText("第一段\n第二段")).toBe("第一段\n\n第二段");
  });
});
