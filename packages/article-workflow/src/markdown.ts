import type {
  Blockquote,
  Code,
  Content,
  Heading,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  TableCell,
  Text,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

function textNodeValue(node: Text): string {
  return node.value;
}

function normalizeVisibleText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\u00a0", " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeSourceText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function stringifyMarkdown(root: Root): string {
  return unified()
    .use(remarkStringify, {
      bullet: "-",
      emphasis: "*",
      fences: true,
      incrementListMarker: false,
      listItemIndent: "one",
      strong: "*",
    })
    .use(remarkGfm)
    .stringify(root)
    .trim();
}

export function parseArticleWorkflowMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
}

function visibleTextFromPhrasing(nodes: readonly PhrasingContent[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return textNodeValue(node);
      case "inlineCode":
        return node.value;
      case "break":
        return "\n";
      case "delete":
      case "emphasis":
      case "strong":
      case "link":
        return visibleTextFromPhrasing(node.children as readonly PhrasingContent[]);
      case "image":
        return (node.alt ?? node.title ?? "").trim();
      default:
        return "";
    }
  }).join("");
}

function visibleTextFromListItem(item: ListItem): string {
  return item.children
    .map((child) => visibleTextFromContent(child))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function visibleTextFromTableCell(cell: TableCell): string {
  return visibleTextFromPhrasing(cell.children as readonly PhrasingContent[]).trim();
}

function visibleTextFromBlockquote(node: Blockquote): string {
  return node.children
    .map((child) => visibleTextFromContent(child))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function visibleTextFromParagraph(node: Paragraph): string {
  return visibleTextFromPhrasing(node.children).trim();
}

function visibleTextFromHeading(node: Heading): string {
  return visibleTextFromPhrasing(node.children).trim();
}

function visibleTextFromCode(node: Code): string {
  return node.value.trim();
}

export function visibleTextFromContent(node: Content): string {
  switch (node.type) {
    case "paragraph":
      return visibleTextFromParagraph(node);
    case "heading":
      return visibleTextFromHeading(node);
    case "blockquote":
      return visibleTextFromBlockquote(node);
    case "list":
      return node.children.map((item) => visibleTextFromListItem(item)).filter(Boolean).join("\n");
    case "table":
      return node.children
        .map((row) => row.children.map((cell) => visibleTextFromTableCell(cell)).join(" | "))
        .join("\n");
    case "code":
      return visibleTextFromCode(node);
    case "thematicBreak":
      return "";
    default:
      return "";
  }
}

export function articleWorkflowVisibleTextFromMarkdown(markdown: string): string {
  const root = parseArticleWorkflowMarkdown(markdown);
  return normalizeVisibleText(
    root.children
      .map((child) => visibleTextFromContent(child))
      .filter(Boolean)
      .join("\n\n"),
  );
}

export function articleWorkflowVisibleTextFromSource(
  format: "plain-text" | "markdown",
  sourceText: string,
): string {
  return format === "markdown"
    ? articleWorkflowVisibleTextFromMarkdown(sourceText)
    : normalizeVisibleText(sourceText);
}

export function articleWorkflowMarkdownFromVisibleText(text: string): string {
  return normalizeVisibleText(text)
    .split("\n")
    .filter(Boolean)
    .join("\n\n");
}

function bodyMarkdownFromPlainText(sourceText: string, title: string): string {
  const normalized = normalizeSourceText(sourceText);
  if (!normalized) return "";

  const paragraphs = normalized.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
  const titleText = title.trim();
  if (!titleText) return paragraphs.join("\n\n");
  if (paragraphs[0] === titleText) return paragraphs.slice(1).join("\n\n").trim();

  const lines = normalized.split("\n");
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
  if (firstNonEmptyIndex >= 0 && lines[firstNonEmptyIndex]?.trim() === titleText) {
    const remaining = [...lines];
    remaining.splice(firstNonEmptyIndex, 1);
    while (remaining[firstNonEmptyIndex]?.trim() === "") remaining.splice(firstNonEmptyIndex, 1);
    return normalizeSourceText(remaining.join("\n"));
  }
  return paragraphs.join("\n\n");
}

function bodyMarkdownFromMarkdown(sourceText: string, title: string): string {
  const normalized = normalizeSourceText(sourceText);
  if (!normalized) return "";

  const titleText = title.trim();
  if (!titleText) return normalized;

  const root = parseArticleWorkflowMarkdown(normalized);
  const [first, ...rest] = root.children;
  if (!first) return normalized;

  const firstText = visibleTextFromContent(first).trim();
  if (first.type === "heading" && firstText === titleText) {
    return stringifyMarkdown({ ...root, children: rest }).trim();
  }
  if (first.type === "paragraph" && firstText === titleText) {
    return stringifyMarkdown({ ...root, children: rest }).trim();
  }
  return normalized;
}

export function articleWorkflowPreservedBodyMarkdown(args: {
  readonly format: "plain-text" | "markdown";
  readonly sourceText: string;
  readonly title?: string;
}): string {
  return args.format === "markdown"
    ? bodyMarkdownFromMarkdown(args.sourceText, args.title ?? "")
    : bodyMarkdownFromPlainText(args.sourceText, args.title ?? "");
}
