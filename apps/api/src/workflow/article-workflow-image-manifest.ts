import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type {
  ArticleWorkflowImageAsset,
  ArticleWorkflowImageRole,
  ArticleWorkflowImageSlot,
} from "@ai-assistant/article-workflow";
import { ARTICLE_WORKFLOW_IMAGE_SLOTS } from "@ai-assistant/article-workflow";

const SERIALIZER = new XMLSerializer();

function slotOrder(slot: ArticleWorkflowImageSlot): number {
  return ARTICLE_WORKFLOW_IMAGE_SLOTS.indexOf(slot);
}

function imageRoleFromSlot(slot: ArticleWorkflowImageSlot): ArticleWorkflowImageRole {
  return slot === "cover" ? "cover" : "inline";
}

export function createPlannedArticleImage(args: {
  readonly slot: ArticleWorkflowImageSlot;
  readonly prompt: string;
  readonly alt?: string;
  readonly caption?: string;
}): ArticleWorkflowImageAsset {
  return {
    slot: args.slot,
    role: imageRoleFromSlot(args.slot),
    assetId: null,
    imageUrl: "",
    thumbnailUrl: "",
    alt: args.alt?.trim() ?? "",
    caption: args.caption?.trim() ?? "",
    prompt: args.prompt.trim(),
  };
}

export function mergeArticleImageManifest(
  planned: readonly ArticleWorkflowImageAsset[],
  current: readonly ArticleWorkflowImageAsset[],
): readonly ArticleWorkflowImageAsset[] {
  const currentBySlot = new Map(current.map((item) => [item.slot, item] as const));
  const merged = planned.map((item) => {
    const existing = currentBySlot.get(item.slot);
    return existing
      ? {
        ...item,
        assetId: existing.assetId,
        imageUrl: existing.imageUrl,
        thumbnailUrl: existing.thumbnailUrl,
        alt: item.alt.trim() || existing.alt,
        caption: item.caption.trim() || existing.caption,
        prompt: item.prompt.trim() || existing.prompt,
      }
      : item;
  });
  const plannedSlots = new Set(merged.map((item) => item.slot));
  const preservedCurrent = current.filter((item) => !plannedSlots.has(item.slot));
  return [...merged, ...preservedCurrent].sort((left, right) => slotOrder(left.slot) - slotOrder(right.slot));
}

export function findArticleImageBySlot(
  imageManifest: readonly ArticleWorkflowImageAsset[],
  slot: ArticleWorkflowImageSlot,
): ArticleWorkflowImageAsset | null {
  return imageManifest.find((item) => item.slot === slot) ?? null;
}

function buildImageSection(document: any, image: ArticleWorkflowImageAsset): any {
  const section = document.createElement("section");
  section.setAttribute("data-ai-assistant-image-slot", image.slot);
  section.setAttribute(
    "style",
    image.role === "cover"
      ? "margin:0 0 28px 0; width:100%; box-sizing:border-box;"
      : "margin:24px 0; width:100%; box-sizing:border-box;",
  );

  const img = document.createElement("img");
  img.setAttribute("data-ai-assistant-image-slot", image.slot);
  img.setAttribute("src", image.imageUrl.trim());
  img.setAttribute("alt", (image.alt.trim() || "文章配图").slice(0, 240));
  img.setAttribute(
    "style",
    "display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:12px;",
  );
  section.appendChild(img);
  return section;
}

function serializeBody(body: any): string {
  return Array.from(body.childNodes as any[]).map((child) => SERIALIZER.serializeToString(child as any)).join("");
}

function findImageSlotElement(root: any, slot: ArticleWorkflowImageSlot): any {
  const nodes = Array.from(root.getElementsByTagName("*") as any[]) as any[];
  return nodes.find((node) =>
    node.tagName.toLowerCase() === "section" && node.getAttribute("data-ai-assistant-image-slot") === slot,
  ) ?? nodes.find((node) => node.getAttribute("data-ai-assistant-image-slot") === slot) ?? null;
}

function replaceWithImageSection(root: any, slot: ArticleWorkflowImageSlot, image: ArticleWorkflowImageAsset) {
  const document = root.ownerDocument;
  if (!document) return;
  const existing = findImageSlotElement(root, slot);
  const next = buildImageSection(document, image);
  if (existing?.parentNode) {
    existing.parentNode.replaceChild(next, existing);
    return;
  }
  root.appendChild(next);
}

export function applyArticleImageManifestToHtml(
  bodyHtml: string,
  imageManifest: readonly ArticleWorkflowImageAsset[],
): string {
  const document = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return bodyHtml;
  imageManifest
    .filter((image) => image.imageUrl.trim())
    .forEach((image) => replaceWithImageSection(body, image.slot, image));
  return serializeBody(body).trim();
}
