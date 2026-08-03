// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArticleWorkflowRichEditor } from "./ArticleWorkflowRichEditor";

/**
 * 真实生成结果的形态：section 三层嵌套、纯内联样式、图片带槽位标记。
 * 这就是被旧编辑器拍平的那种 HTML，所以拿它当回归基线。
 */
const wechatBody = [
  '<section style="margin:0;padding:0 12px;font-size:16px;line-height:1.9;color:#2c3e50;letter-spacing:0.5px">',
  '<section style="margin-bottom:28px">',
  '<section data-ai-assistant-image-slot="cover" style="margin:0 auto 20px;max-width:100%;text-align:center">',
  '<img data-ai-assistant-image-slot="cover" src="https://cdn.example.com/cover.png" alt="封面图" style="display:block;width:100%;border-radius:12px" />',
  "</section>",
  '<p style="margin:0 0 18px;text-indent:2em">开头第一段，讲清楚这篇要说什么。</p>',
  "</section>",
  '<section style="margin-bottom:28px;padding:16px;background:#f7f9fc;border-radius:10px">',
  '<p style="margin:0 0 12px;font-weight:600;color:#1a73e8">小标题在这里</p>',
  '<p style="margin:0">正文里有<strong style="color:#e74c3c">强调</strong>和<em>斜体</em>。</p>',
  "</section>",
  '<section data-ai-assistant-image-slot="body-1" style="margin:0 auto 24px;max-width:100%">',
  '<img data-ai-assistant-image-slot="body-1" src="https://cdn.example.com/body-1.png" alt="配图一" style="display:block;width:100%;border-radius:12px" />',
  "</section>",
  '<section style="margin:0"><p style="margin:0;text-align:center;color:#8a94a6;font-size:14px">结尾一句话。</p></section>',
  "</section>",
].join("");

function surface(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".article-workflow-rich-editor__surface");
  if (!node) throw new Error("找不到编辑区");
  return node;
}

async function mountEditor(value: string, onChange = vi.fn()) {
  render(
    <ArticleWorkflowRichEditor value={value} syncKey="row-1" onChange={onChange} />,
  );
  // 编辑器是动态 import 的，等工具栏可用即代表实例装好了
  await waitFor(() => {
    expect(screen.getByLabelText("加粗")).not.toBeDisabled();
  });
  return { onChange };
}

describe("ArticleWorkflowRichEditor 载入即保真", () => {
  it("公众号版式过一遍编辑器不掉东西", async () => {
    await mountEditor(wechatBody);
    const root = surface();

    // section 结构和层级
    expect(root.querySelectorAll("section").length).toBe(
      (wechatBody.match(/<section/g) ?? []).length,
    );
    // 图片槽位是回写图片的锚点，丢一个就会在保存时重复追加图片
    expect(root.querySelectorAll("[data-ai-assistant-image-slot]").length).toBe(4);
    expect(
      root.querySelector('section[data-ai-assistant-image-slot="cover"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('section[data-ai-assistant-image-slot="body-1"]'),
    ).not.toBeNull();

    // 内联样式必须逐条在，公众号只认内联 CSS
    const outer = root.querySelector("section");
    expect(outer?.getAttribute("style")).toContain("letter-spacing:0.5px");
    expect(root.innerHTML).toContain("background:#f7f9fc");
    expect(root.innerHTML).toContain("text-indent:2em");
    expect(root.innerHTML).toContain("color:#e74c3c");

    // 图片属性
    const cover = root.querySelector<HTMLImageElement>('img[data-ai-assistant-image-slot="cover"]');
    expect(cover?.getAttribute("src")).toBe("https://cdn.example.com/cover.png");
    expect(cover?.getAttribute("alt")).toBe("封面图");

    // 文字一个不少
    expect(root.textContent).toContain("开头第一段，讲清楚这篇要说什么。");
    expect(root.textContent).toContain("小标题在这里");
    expect(root.textContent).toContain("结尾一句话。");
  });

  it("只是打开、不动手，不会触发 onChange（旧编辑器就是在这一步把成品写坏的）", async () => {
    const onChange = vi.fn();
    await mountEditor(wechatBody, onChange);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("失焦提交拿到的 HTML 跟载入的等价，没有被规范化", async () => {
    const onBlurCommit = vi.fn();
    render(
      <ArticleWorkflowRichEditor
        value={wechatBody}
        syncKey="row-1"
        onChange={vi.fn()}
        onBlurCommit={onBlurCommit}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("加粗")).not.toBeDisabled();
    });

    await act(async () => {
      surface().focus();
      surface().blur();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(onBlurCommit).toHaveBeenCalled();
    const committed = onBlurCommit.mock.calls[0]?.[0] as string;
    expect((committed.match(/<section/gi) ?? []).length).toBe(
      (wechatBody.match(/<section/g) ?? []).length,
    );
    expect((committed.match(/data-ai-assistant-image-slot/gi) ?? []).length).toBe(4);
    expect(committed).toContain("letter-spacing:0.5px");
  });

  it("编辑文字后仍保留空图片槽位，后续配图可以原位注入", async () => {
    const emptySlotBody = [
      '<section style="margin:0;padding:0 12px">',
      '<section data-ai-assistant-image-slot="cover"></section>',
      '<p style="margin:0">先确认的正文。</p>',
      '<section data-ai-assistant-image-slot="inline-1"></section>',
      "</section>",
    ].join("");
    const onChange = vi.fn();
    await mountEditor(emptySlotBody, onChange);
    const root = surface();

    expect(root.querySelector('section[data-ai-assistant-image-slot="cover"]')).not.toBeNull();
    expect(root.querySelector('section[data-ai-assistant-image-slot="inline-1"]')).not.toBeNull();

    const paragraph = root.querySelector("p");
    if (!paragraph) throw new Error("找不到正文段落");
    paragraph.textContent = "人工确认后的正文。";
    paragraph.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = onChange.mock.calls.at(-1)?.[0] as string;
    expect(saved).toContain('data-ai-assistant-image-slot="cover"');
    expect(saved).toContain('data-ai-assistant-image-slot="inline-1"');
    expect(saved).toContain("人工确认后的正文。");
  });
});
