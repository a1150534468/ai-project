import { DOMParser } from "@xmldom/xmldom";
import type { ArticleWorkflowImageSlot } from "@ai-assistant/article-workflow";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";

const ALLOWED_TAGS = new Set([
  "section",
  "div",
  "p",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "br",
  "ul",
  "ol",
  "li",
  "table",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "svg",
  "a",
  "blockquote",
  "hr",
]);

const BLOCKED_TAGS = new Set([
  "html",
  "head",
  "body",
  "meta",
  "title",
  "link",
  "style",
  "script",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "iframe",
  "audio",
  "video",
  "object",
  "embed",
  "foreignobject",
]);

const ALLOWED_ATTRS = new Set([
  "style",
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "viewbox",
  "fill",
  "stroke",
  "stroke-width",
  "xmlns",
  "colspan",
  "rowspan",
  "data-ai-assistant-image-slot",
  "target",
  "rel",
]);

const BLOCKED_STYLE_PROPS = new Set([
  "position",
  "float",
  "clear",
  "z-index",
  "filter",
  "column-count",
  "column-gap",
  "columns",
  "transform",
  "animation",
]);

const FORBIDDEN_VISIBLE_PHRASES = [
  "当前项目直接复用",
  "编辑区只处理输入",
  "自动保存也只在内容真改动后触发",
  "这里看到的是最终要复制到公众号正文区的格式",
  "公众号图文工作流",
  "多平台图文工作流",
];

function validateStyle(styleText: string) {
  for (const declaration of styleText.split(";")) {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim().toLowerCase();
    if (!property) continue;
    if (BLOCKED_STYLE_PROPS.has(property)) {
      throw new Error(`HTML 包含不支持的样式属性: ${property}`);
    }
    if (property.startsWith("margin") && value.includes("-")) {
      throw new Error(`HTML 包含负 margin: ${property}`);
    }
    if (property === "height" && value && value !== "auto") {
      throw new Error("HTML 使用了固定 height");
    }
    if (property === "background-image" || value.includes("url(")) {
      throw new Error("HTML 包含不支持的背景图片样式");
    }
  }
}

function walk(node: any, requiredSlots: Set<string>) {
  if (node.nodeType === node.COMMENT_NODE) {
    throw new Error("HTML 中不能包含注释");
  }
  if (node.nodeType !== node.ELEMENT_NODE) return;

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  if (BLOCKED_TAGS.has(tagName)) {
    throw new Error(`HTML 包含不支持的标签: <${tagName}>`);
  }
  if (!ALLOWED_TAGS.has(tagName)) {
    throw new Error(`HTML 包含未允许的标签: <${tagName}>`);
  }

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) {
      throw new Error(`HTML 包含不支持的属性: ${attr.name}`);
    }
    if (name === "style") validateStyle(attr.value);
  }

  const slot = element.getAttribute("data-ai-assistant-image-slot")?.trim();
  if (slot) requiredSlots.delete(slot);
  Array.from(element.childNodes).forEach((child) => walk(child, requiredSlots));
}

export function assertArticleWorkflowHtmlFragment(args: {
  readonly html: string;
  readonly expectedVisibleText: string;
  readonly requiredImageSlots?: readonly ArticleWorkflowImageSlot[];
}): string {
  const normalizedHtml = args.html.replaceAll("\r\n", "\n").trim();
  if (!normalizedHtml) throw new Error("模型没有返回正文 HTML");
  if (normalizedHtml.includes("<!--")) throw new Error("HTML 中不能包含注释");

  const document = new DOMParser().parseFromString(`<body>${normalizedHtml}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) throw new Error("HTML 解析失败");

  const requiredSlots = new Set(args.requiredImageSlots ?? []);
  Array.from(body.childNodes).forEach((child) => walk(child, requiredSlots));
  if (requiredSlots.size > 0) {
    throw new Error(`HTML 缺少图片槽位: ${Array.from(requiredSlots).join(", ")}`);
  }

  const visibleText = articleWorkflowVisibleTextFromHtml(normalizedHtml);
  if (visibleText !== args.expectedVisibleText.trim()) {
    throw new Error("HTML 可见文字与预期内容不一致");
  }
  for (const phrase of FORBIDDEN_VISIBLE_PHRASES) {
    if (visibleText.includes(phrase)) {
      throw new Error("HTML 中混入了解释性文案");
    }
  }
  return normalizedHtml;
}
