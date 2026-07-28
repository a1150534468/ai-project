import type { RefObject } from "react";
import { copyArticleWorkflowBody, copyArticleWorkflowPlainText } from "./articleWorkflowClipboard";

const BLOCK_TAGS = new Set([
  "section",
  "div",
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
]);

function normalizePlainText(value: string): string {
  return value
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function appendNodeText(node: Node, parts: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.nodeValue ?? "");
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  const tagName = node.tagName.toLowerCase();
  if (tagName === "br") {
    parts.push("\n");
    return;
  }
  if (BLOCK_TAGS.has(tagName) && parts.length > 0) {
    parts.push("\n");
  }
  for (const child of Array.from(node.childNodes)) {
    appendNodeText(child, parts);
  }
  if (BLOCK_TAGS.has(tagName)) {
    parts.push("\n");
  }
}

function plainTextFromHtml(html: string): string {
  if (typeof window === "undefined") return html;
  const parser = new DOMParser();
  const document = parser.parseFromString(`<body>${html}</body>`, "text/html");
  const parts: string[] = [];
  for (const child of Array.from(document.body.childNodes)) {
    appendNodeText(child, parts);
  }
  return normalizePlainText(parts.join(""));
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
  const handleCopyBody = async () => {
    try {
      const mode = await copyArticleWorkflowBody({
        html: args.bodyHtmlDraft,
        plainText: plainTextFromHtml(args.bodyHtmlDraft),
        previewNode: args.previewBodyRef.current,
      });
      args.setError("");
      args.setNotice(mode === "plain" ? "已复制纯文本正文" : "已复制公众号正文");
      args.toast.show("ok", mode === "plain" ? "已复制纯文本正文" : "已复制公众号正文");
    } catch (error) {
      const message = error instanceof Error ? error.message : "复制正文失败";
      args.setError(message);
      args.toast.show("err", message);
    }
  };

  const handleCopyTitle = async () => {
    try {
      await copyArticleWorkflowPlainText(args.titleDraft.trim());
      args.setError("");
      args.setNotice("已复制标题");
      args.toast.show("ok", "已复制标题");
    } catch (error) {
      const message = error instanceof Error ? error.message : "复制标题失败";
      args.setError(message);
      args.toast.show("err", message);
    }
  };

  const handleCopySummary = async () => {
    try {
      await copyArticleWorkflowPlainText(args.summaryDraft.trim());
      args.setError("");
      args.setNotice("已复制摘要");
      args.toast.show("ok", "已复制摘要");
    } catch (error) {
      const message = error instanceof Error ? error.message : "复制摘要失败";
      args.setError(message);
      args.toast.show("err", message);
    }
  };

  const copyPlain = async (value: string, okText: string, failText: string) => {
    try {
      await copyArticleWorkflowPlainText(value);
      args.setError("");
      args.setNotice(okText);
      args.toast.show("ok", okText);
    } catch (error) {
      const message = error instanceof Error ? error.message : failText;
      args.setError(message);
      args.toast.show("err", message);
    }
  };

  const handleCopyCaption = () => copyPlain(
    (args.captionDraft ?? "").trim(),
    "已复制文案",
    "复制文案失败",
  );

  const handleCopyTags = () => copyPlain(
    articleWorkflowTagsText(args.tagsDraft ?? []),
    "已复制标签",
    "复制标签失败",
  );

  return { handleCopyBody, handleCopyTitle, handleCopySummary, handleCopyCaption, handleCopyTags };
}
