// @vitest-environment jsdom

/**
 * 复制动作这一层原来一条用例都没有 —— 五颗按钮里唯一有算法的那段（把公众号正文铺成纯文本）
 * 就这么裸奔着。这次改写把「块级标签清单」翻成「行内标签清单」，正好拿用例把口径钉下来：
 * 断行断在哪、空白怎么收、以及哪句话会进 toast。
 *
 * 剪贴板整个 mock 掉：这层不负责写剪贴板，只负责决定「写什么」和「成了/没成之后说什么」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { articleWorkflowTagsText, createArticleWorkflowCopyActions } from "./articleWorkflowCopyActions";

const clipboard = vi.hoisted(() => ({
  copyArticleWorkflowBody: vi.fn(),
  copyArticleWorkflowPlainText: vi.fn(),
}));

vi.mock("./articleWorkflowClipboard", () => clipboard);

type Args = Parameters<typeof createArticleWorkflowCopyActions>[0];

function harness(overrides: Partial<Args> = {}) {
  const toast = { show: vi.fn() };
  const setError = vi.fn();
  const setNotice = vi.fn();
  const actions = createArticleWorkflowCopyActions({
    previewBodyRef: { current: null },
    titleDraft: "  咖啡机夏促  ",
    summaryDraft: " 适合公众号摘要 ",
    bodyHtmlDraft: "",
    toast,
    setError,
    setNotice,
    ...overrides,
  });
  return { actions, toast, setError, setNotice };
}

/** 正文那颗按钮交给剪贴板的纯文本版本。 */
async function plainTextOf(bodyHtml: string): Promise<string> {
  clipboard.copyArticleWorkflowBody.mockResolvedValue("html");
  await harness({ bodyHtmlDraft: bodyHtml }).actions.handleCopyBody();
  const [args] = clipboard.copyArticleWorkflowBody.mock.calls.at(-1) as [{ plainText: string }];
  return args.plainText;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("正文铺成纯文本", () => {
  it("块级标签各占一行，行内标签接着上文走", async () => {
    expect(await plainTextOf("<section><p>第一段<strong>要点</strong>收尾</p><p>第二段</p></section>")).toBe(
      "第一段要点收尾\n第二段",
    );
  });

  it("小标题不再跟后面的正文挤成一行：h1–h6 原来漏在块级清单外", async () => {
    expect(await plainTextOf("<h2>小标题</h2>正文紧跟着<h3>次级</h3>")).toBe("小标题\n正文紧跟着\n次级");
  });

  it("<br> 断一行，连着两个也只断一行", async () => {
    expect(await plainTextOf("<p>第一行<br>第二行</p>")).toBe("第一行\n第二行");
    expect(await plainTextOf("<p>上<br><br>下</p>")).toBe("上\n下");
  });

  it("缩进、空行、NBSP 一起收掉，NBSP 换成能被 trim 认出来的普通空格", async () => {
    const html = "<section>\n  <p>  带缩进 的一行  </p>\n\n  <p>下一段 </p>\n</section>";

    expect(await plainTextOf(html)).toBe("带缩进 的一行\n下一段");
  });

  it("表格每个格子一行，图片这类空标签不留空行", async () => {
    const html = '<table><tbody><tr><td>左</td><td>右</td></tr></tbody></table><p><img src="x.png" alt="图"></p>';

    expect(await plainTextOf(html)).toBe("左\n右");
  });
});

describe("按钮说什么话", () => {
  it("走到纯文本兜底要说清楚没排版，成功一并清掉上一条错误", async () => {
    clipboard.copyArticleWorkflowBody.mockResolvedValue("plain");
    const node = document.createElement("div");
    const { actions, toast, setError, setNotice } = harness({ previewBodyRef: { current: node } });

    await actions.handleCopyBody();

    expect(clipboard.copyArticleWorkflowBody).toHaveBeenCalledWith(expect.objectContaining({ previewNode: node }));
    expect(setNotice).toHaveBeenCalledWith("已复制纯文本正文");
    expect(toast.show).toHaveBeenCalledWith("ok", "已复制纯文本正文");
    expect(setError).toHaveBeenCalledWith("");
  });

  it("选区那条路也是带排版的，说的话跟 html 一样", async () => {
    clipboard.copyArticleWorkflowBody.mockResolvedValue("selection");
    const { actions, toast } = harness();

    await actions.handleCopyBody();

    expect(toast.show).toHaveBeenCalledWith("ok", "已复制公众号正文");
  });

  it("浏览器拒绝时把原话交给用户，notice 不动", async () => {
    const refused = "浏览器不允许写入剪贴板，请手动选中复制";
    clipboard.copyArticleWorkflowBody.mockRejectedValue(new Error(refused));
    const { actions, toast, setError, setNotice } = harness();

    await actions.handleCopyBody();

    expect(setError).toHaveBeenCalledWith(refused);
    expect(toast.show).toHaveBeenCalledWith("err", refused);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("抛出来的不是 Error 就拿按钮名字凑一句，不让 [object Object] 进 toast", async () => {
    clipboard.copyArticleWorkflowBody.mockRejectedValue({ code: 500 });
    const { actions, toast } = harness();

    await actions.handleCopyBody();

    expect(toast.show).toHaveBeenCalledWith("err", "复制正文失败");
  });

  it("标题、摘要、文案都掐掉首尾空白再写", async () => {
    clipboard.copyArticleWorkflowPlainText.mockResolvedValue(undefined);
    const { actions, toast } = harness({ captionDraft: "\n第一次用就回不去了。\n" });

    await actions.handleCopyTitle();
    await actions.handleCopySummary();
    await actions.handleCopyCaption();

    expect(clipboard.copyArticleWorkflowPlainText.mock.calls.map(([text]) => text)).toEqual([
      "咖啡机夏促",
      "适合公众号摘要",
      "第一次用就回不去了。",
    ]);
    expect(toast.show).toHaveBeenLastCalledWith("ok", "已复制文案");
  });
});

describe("标签拼成平台习惯的那一串", () => {
  it("补井号、去空白、丢掉空标签，多余的井号不叠", () => {
    expect(articleWorkflowTagsText(["#咖啡机", " 居家好物 ", "", "  ", "##夏日饮品"])).toBe(
      "#咖啡机 #居家好物 #夏日饮品",
    );
  });

  it("一个标签都没有就给空串，不给一个孤零零的井号", () => {
    expect(articleWorkflowTagsText([])).toBe("");
  });
});
