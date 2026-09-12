import { DOMParser } from "@xmldom/xmldom";

const BLOCK_TAGS = new Set([
  "section", "div", "p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "pre",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "hr",
]);

function normalize(value: string): string {
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

function visit(node: any, output: string[]): void {
  if (node.nodeType === node.TEXT_NODE) {
    if (node.nodeValue) output.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return;
  const tag = node.tagName.toLowerCase();
  if (tag === "br") output.push("\n");
  if (BLOCK_TAGS.has(tag) && output.length) output.push("\n");
  Array.from(node.childNodes).forEach((child) => visit(child, output));
  if (BLOCK_TAGS.has(tag)) output.push("\n");
}

export function articleWorkflowVisibleTextFromHtml(html: string): string {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return "";
  const output: string[] = [];
  Array.from(body.childNodes).forEach((node) => visit(node, output));
  return normalize(output.join(""));
}
