/**
 * 五颗「复制」按钮的动作。原来标题、摘要各写了一遍 `copyPlain` 里那段一模一样的 try/catch，
 * 而 `copyPlain` 就在同一个工厂里给文案和标签用着 —— 同一段错误处理落了三份。现在只有
 * 一个 `run`：**成功说什么由动作自己返回，失败说什么由动作的名字拼出来**。
 *
 * 富文本铺平那侧收掉两处：
 *
 *  - **标签清单反过来列**。原来手列 15 个块级标签，`h1`–`h6`、`pre`、`thead`、`tfoot` 一个都不在
 *    里面 —— 素材是 Markdown，`##` 排出来就是 `<h2>`，于是小标题跟后面的正文挤成一行。
 *    改成列行内标签：那一侧就那么十几个，而且不会跟着 Markdown 能排出什么一起长。
 *  - **断行不再分「是不是第一个块」**。多出来的空行反正要在收尾统一压掉，
 *    递归里那个 `parts.length > 0` 是白判的。
 */
import type { RefObject } from "react";
import { copyArticleWorkflowBody, copyArticleWorkflowPlainText } from "./articleWorkflowClipboard";

/**
 * 纯文本里跟着上文走、不单独占行的标签。词汇表
 * （packages/article-workflow/src/html-vocabulary.ts）里其余的标签一律各占一行，
 * `<br>` 也走那条 —— 它没有子节点，前后各断一行等于断一行。
 */
const INLINE_TAGS = new Set(["span", "strong", "b", "em", "i", "u", "s", "mark", "a", "code", "img", "svg"]);

/**
 * 逐行去掉首尾空白，再把空行压成一个换行。NBSP 得先换成普通空格 —— 它不算空白字符，留着就去不掉。
 * `[^\S\n]` 是「除换行以外的空白」，`\r` 与全角空格都在里面，口径跟 `trim()` 一致。
 */
function tidyLines(text: string): string {
  return text
    .replaceAll("\u00a0", " ")
    .replace(/^[^\S\n]+|[^\S\n]+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

/** 按文档顺序把文字吐成片段流：行内标签接着上文，其余标签前后各断一行。 */
function* textFragments(node: Node): Generator<string> {
  if (node.nodeType === Node.TEXT_NODE) {
    yield node.nodeValue ?? "";
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  const inline = INLINE_TAGS.has(node.tagName.toLowerCase());
  if (!inline) yield "\n";
  for (const child of node.childNodes) yield* textFragments(child);
  if (!inline) yield "\n";
}

/** 服务端渲染时没有 DOMParser。原样交回去 —— 调用方拿它写剪贴板，不是拿去存库。 */
function plainTextFromHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html;

  // 包一层 body：碎片式的 HTML 直接解析会被塞进 head，`<section>` 这类连标签都留不下
  const { body } = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return tidyLines([...textFragments(body)].join(""));
}

/** 小红书/抖音的标签按平台习惯拼成 `#标签` 空格分隔 */
export function articleWorkflowTagsText(tags: readonly string[]): string {
  return tags
    .map((tag) => tag.trim().replace(/^#+/, "").trim())
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");
}

export function createArticleWorkflowCopyActions(args: {
  readonly previewBodyRef: RefObject<HTMLDivElement | null>;
  readonly titleDraft: string;
  readonly summaryDraft: string;
  readonly bodyHtmlDraft: string;
  readonly captionDraft?: string;
  readonly tagsDraft?: readonly string[];
  readonly toast: { show: (kind: "ok" | "err", text: string) => void };
  readonly setError: (value: string) => void;
  readonly setNotice: (value: string) => void;
}) {
  /**
   * 五个动作的收尾逐字相同：成功清掉上一条错误、留一句 notice 并弹同一句 toast，
   * 失败把原文照抄进 toast。`copy` 返回的就是成功时要说的那句话。
   */
  const run = async (label: string, copy: () => Promise<string>) => {
    try {
      const done = await copy();
      args.setError("");
      args.setNotice(done);
      args.toast.show("ok", done);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : `复制${label}失败`;
      args.setError(message);
      args.toast.show("err", message);
    }
  };

  /** 纯文本那四颗按钮。取值是个函数：`args` 每次渲染都是新的，但点下去要读的是当下的草稿。 */
  const plain = (label: string, value: () => string) => () =>
    run(label, async () => {
      await copyArticleWorkflowPlainText(value());
      return `已复制${label}`;
    });

  return {
    handleCopyBody: () =>
      run("正文", async () => {
        const kind = await copyArticleWorkflowBody({
          html: args.bodyHtmlDraft,
          plainText: plainTextFromHtml(args.bodyHtmlDraft),
          previewNode: args.previewBodyRef.current,
        });

        // 退到纯文本得说清楚：用户拿去粘的那份没有排版
        return kind === "plain" ? "已复制纯文本正文" : "已复制公众号正文";
      }),
    handleCopyTitle: plain("标题", () => args.titleDraft.trim()),
    handleCopySummary: plain("摘要", () => args.summaryDraft.trim()),
    handleCopyCaption: plain("文案", () => (args.captionDraft ?? "").trim()),
    handleCopyTags: plain("标签", () => articleWorkflowTagsText(args.tagsDraft ?? [])),
  };
}
