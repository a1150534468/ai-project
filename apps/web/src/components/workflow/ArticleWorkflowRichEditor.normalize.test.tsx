// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArticleWorkflowRichEditor } from "./ArticleWorkflowRichEditor";

/**
 * 载入时的「静默改写」检查。
 *
 * Squire 内部有 stylesRewriters（STRONG→B、EM→I 之类）。如果它在载入阶段动手，
 * 失焦提交就会把改写后的 HTML 当成用户编辑结果写回库里——那是旧编辑器毁稿的同一条路径。
 * 这组用例把「载入后第一次失焦提交的内容」和「库里原文」逐项对齐。
 */
const bodyWithInlineMarks = [
  '<section style="margin:0;font-size:16px">',
  '<p style="margin:0 0 12px">正文里有<strong style="color:#e74c3c">强调</strong>，还有<em>斜体</em>和<u>下划线</u>。</p>',
  '<section data-ai-assistant-image-slot="cover" style="margin:0 auto">',
  '<img data-ai-assistant-image-slot="cover" src="https://cdn.example.com/c.png" alt="封面" style="width:100%" />',
  "</section>",
  "</section>",
].join("");

async function mountAndBlur(value: string) {
  const onChange = vi.fn();
  const onBlurCommit = vi.fn();
  render(
    <ArticleWorkflowRichEditor
      value={value}
      syncKey="row-1"
      onChange={onChange}
      onBlurCommit={onBlurCommit}
    />,
  );
  await waitFor(() => {
    expect(screen.getByLabelText("加粗")).not.toBeDisabled();
  });
  const surface = document.querySelector<HTMLElement>(".article-workflow-rich-editor__surface");
  if (!surface) throw new Error("找不到编辑区");
  await act(async () => {
    surface.focus();
    surface.blur();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    onChange,
    committed: (onBlurCommit.mock.calls[0]?.[0] ?? "") as string,
  };
}

describe("载入不静默改写内容", () => {
  it("用户没动过，失焦提交的就是原字节", async () => {
    // Squire 载入时会把 strong→b、em→i，还会给只含图片的块补 br。
    // 这些改写等价但不是用户意图，一旦提交上去就会被自动保存写进库。
    const { committed } = await mountAndBlur(bodyWithInlineMarks);

    expect(committed).toBe(bodyWithInlineMarks);
    expect(committed).toContain("<strong");
    expect(committed).toContain("<em");
  });

  it("原文的 section、槽位、内联样式一条都不少", async () => {
    const { committed } = await mountAndBlur(bodyWithInlineMarks);

    expect((committed.match(/<section/gi) ?? []).length).toBe(2);
    expect((committed.match(/data-ai-assistant-image-slot/gi) ?? []).length).toBe(2);
    expect(committed).toContain("color:#e74c3c");
    expect(committed).toContain('src="https://cdn.example.com/c.png"');
    expect(committed).toContain('alt="封面"');
  });

  it("光打开再失焦，不算内容改动", async () => {
    const { onChange } = await mountAndBlur(bodyWithInlineMarks);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("base64 图片也留着：被写坏那行正文里全是内联 data URL，修复流程不能把它们洗掉", async () => {
    const body = [
      '<section data-ai-assistant-image-slot="cover" style="margin:0">',
      '<img data-ai-assistant-image-slot="cover" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="封面" style="width:100%" />',
      "</section>",
    ].join("");
    const { committed } = await mountAndBlur(body);

    expect(committed).toContain("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
    expect((committed.match(/data-ai-assistant-image-slot/gi) ?? []).length).toBe(2);
  });

  it("真的改了字，才提交编辑器的 HTML", async () => {
    const onChange = vi.fn();
    const onBlurCommit = vi.fn();
    render(
      <ArticleWorkflowRichEditor
        value={bodyWithInlineMarks}
        syncKey="row-1"
        onChange={onChange}
        onBlurCommit={onBlurCommit}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("加粗")).not.toBeDisabled();
    });
    const surface = document.querySelector<HTMLElement>(".article-workflow-rich-editor__surface");
    if (!surface) throw new Error("找不到编辑区");

    await act(async () => {
      surface.focus();
      const paragraph = surface.querySelector("p");
      if (paragraph) paragraph.append("补一句。");
      surface.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(onChange).toHaveBeenCalled();
    const emitted = onChange.mock.calls.at(-1)?.[0] as string;
    expect(emitted).toContain("补一句。");
    // 改动照样不能把版式带走
    expect((emitted.match(/data-ai-assistant-image-slot/gi) ?? []).length).toBe(2);
  });
});
