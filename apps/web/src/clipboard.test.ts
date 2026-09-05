// @vitest-environment jsdom

/**
 * 剪贴板这三条路原来一条用例都没有，而这一版恰好改的是「谁先成算谁、不成怎么退」——
 * 所以用例都压在退路上：第一条被拒会不会往下走、`writeText` 被拒还有没有兜底、
 * 三条都不给写时抛出来的是给人看的话还是 `execCommand` 的 TypeError。
 * 现在这条链有两个调用方（图文的五颗复制按钮、对话里的「复制这条回复」），退路只有这一份。
 *
 * jsdom 既没有异步剪贴板也没有 `execCommand`，两样都得自己摆上来 —— 这本身就是那条
 * 「先探再用」的由来。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyRichText, copyPlainText } from "./clipboard";

const REFUSED = "浏览器不允许写入剪贴板，请手动选中复制";

function stubAsyncClipboard(impl: Partial<Clipboard>) {
  Object.defineProperty(navigator, "clipboard", { value: impl, configurable: true });
}

/** 只留下构造参数：断言写进去的是哪几种 MIME，不必真去读 Blob。 */
function stubClipboardItem() {
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly parts: Record<string, Blob>) {}
    },
  );
}

function mimeTypesOf(items: unknown[]): string[] {
  return Object.keys((items[0] as { parts: Record<string, Blob> }).parts);
}

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("正文按保真度往下退", () => {
  it("第一条就成：一次写 text/html 与 text/plain", async () => {
    const write = vi.fn(async (_items: unknown[]) => undefined);
    stubAsyncClipboard({ write });
    stubClipboardItem();

    const kind = await copyRichText({ html: "<p>正文</p>", plainText: "正文", previewNode: null });

    expect(kind).toBe("html");
    expect(mimeTypesOf(write.mock.calls[0]![0])).toEqual(["text/html", "text/plain"]);
  });

  it("第一条被拒就退到选区：把预览里那段渲好的 DOM 选起来", async () => {
    stubAsyncClipboard({
      write: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    stubClipboardItem();
    const preview = document.createElement("div");
    preview.textContent = "渲好的正文";
    document.body.append(preview);
    let selected = "";
    document.execCommand = vi.fn(() => {
      selected = window.getSelection()?.toString() ?? "";
      return true;
    });

    const kind = await copyRichText({ html: "<p>x</p>", plainText: "x", previewNode: preview });

    expect(kind).toBe("selection");
    expect(selected).toBe("渲好的正文");
  });

  it("没有 ClipboardItem 又没有预览节点：直接退到纯文本", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    stubAsyncClipboard({ writeText });

    const kind = await copyRichText({ html: "<p>正文</p>", plainText: "正文", previewNode: null });

    expect(kind).toBe("plain");
    expect(writeText).toHaveBeenCalledWith("正文");
  });

  it("三条路都不给写时抛的是给人看的那句话，不是 execCommand 的 TypeError", async () => {
    const previewNode = document.createElement("div");

    await expect(copyRichText({ html: "<p>x</p>", plainText: "x", previewNode })).rejects.toThrow(REFUSED);
  });
});

describe("纯文本兜底", () => {
  it("writeText 被拒不算完：还有屏幕外 textarea 那条路", async () => {
    stubAsyncClipboard({
      writeText: vi.fn(async () => {
        throw new Error("Document is not focused");
      }),
    });
    let carried = "";
    document.execCommand = vi.fn(() => {
      carried = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });

    await expect(copyPlainText("标题")).resolves.toBeUndefined();

    expect(carried).toBe("标题");
    // 借来的 textarea 用完就收，不留在 DOM 里
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("用户在页面上选中的那段，复制完还在", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "用户手动选中的一段";
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    document.execCommand = vi.fn(() => {
      // 真浏览器里 textarea.select() 会把文档选区抢走，jsdom 不会 —— 手动抢一下，
      // 不然这条用例证明不了「还回去了」
      window.getSelection()?.removeAllRanges();
      return true;
    });

    await copyPlainText("标题");

    expect(window.getSelection()?.toString()).toBe("用户手动选中的一段");
  });

  it("光标停在哪个输入框，复制完还停在那儿", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    let borrowed = "";
    document.execCommand = vi.fn(() => {
      borrowed = document.activeElement?.tagName ?? "";
      return true;
    });

    await copyPlainText("标题");

    // 中途确实把焦点借走了，所以「还回去」不是句空话
    expect(borrowed).toBe("TEXTAREA");
    expect(document.activeElement).toBe(input);
  });

  it("连 execCommand 都没有就抛，好让上层去说话", async () => {
    await expect(copyPlainText("标题")).rejects.toThrow(REFUSED);
  });
});
