import { DOMParser } from "@xmldom/xmldom";

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

function normalizeVisibleText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function appendText(parts: string[], text: string) {
  if (!text) return;
  parts.push(text);
}

function visit(node: any, parts: string[]) {
  if (node.nodeType === node.TEXT_NODE) {
    appendText(parts, node.nodeValue ?? "");
    return;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return;

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "br") {
    parts.push("\n");
    return;
  }

  if (BLOCK_TAGS.has(tagName) && parts.length > 0) {
    parts.push("\n");
  }

  const children = Array.from(element.childNodes);
  for (const child of children) visit(child, parts);

  if (BLOCK_TAGS.has(tagName)) {
    parts.push("\n");
  }
}

export function articleWorkflowVisibleTextFromHtml(html: string): string {
  const wrapped = `<body>${html}</body>`;
  const document = new DOMParser().parseFromString(wrapped, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return "";
  const parts: string[] = [];
  Array.from(body.childNodes).forEach((node) => visit(node, parts));
  return normalizeVisibleText(parts.join(""));
}
