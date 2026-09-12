import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  ARTICLE_BLOCKED_STYLE_PROPERTIES,
  ARTICLE_HTML_ATTRIBUTES,
  ARTICLE_HTML_BLOCKED_TAGS,
  ARTICLE_HTML_TAGS,
} from "./article-workflow-html-policy.js";

function repairStyle(styleText: string): string | null {
  const kept = styleText.split(";").flatMap((declaration) => {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim();
    const lowered = value.toLowerCase();
    if (!property || !value || ARTICLE_BLOCKED_STYLE_PROPERTIES.has(property)) return [];
    if (property.startsWith("margin") && lowered.includes("-")) return [];
    if (property === "height" && lowered !== "auto") return [];
    if (property === "background-image" || lowered.includes("url(")) return [];
    return [`${property}:${value}`];
  });
  return kept.length ? kept.join(";") : null;
}

function repairNode(node: any): void {
  for (const child of Array.from(node.childNodes ?? []) as any[]) {
    if (child.nodeType === 8 || child.nodeType === 1 && ARTICLE_HTML_BLOCKED_TAGS.has(String(child.tagName).toLowerCase())) {
      node.removeChild(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tagName = String(child.tagName ?? "").toLowerCase();
    if (!ARTICLE_HTML_TAGS.has(tagName)) {
      repairNode(child);
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      node.removeChild(child);
      continue;
    }
    for (const attr of Array.from(child.attributes ?? []) as any[]) {
      const name = String(attr.name).toLowerCase();
      if (!ARTICLE_HTML_ATTRIBUTES.has(name)) {
        child.removeAttribute(attr.name);
      } else if (name === "style") {
        const repaired = repairStyle(attr.value);
        repaired ? child.setAttribute("style", repaired) : child.removeAttribute("style");
      }
    }
    repairNode(child);
  }
}

export function repairArticleWorkflowHtmlFragment(html: string): string {
  const normalized = html.replaceAll("\r\n", "\n").trim();
  if (!normalized) return normalized;
  const document = new DOMParser().parseFromString(`<body>${normalized}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return normalized;
  repairNode(body);
  const serializer = new XMLSerializer();
  return Array.from(body.childNodes)
    .map((child) => serializer.serializeToString(child as any))
    .join("")
    .trim();
}
