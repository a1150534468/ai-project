import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowImageRole,
  type ArticleWorkflowImageSlot,
} from "@ai-assistant/article-workflow";

const serializer = new XMLSerializer();
const slotIndex = (slot: ArticleWorkflowImageSlot) => ARTICLE_WORKFLOW_IMAGE_SLOTS.indexOf(slot);
const roleFor = (slot: ArticleWorkflowImageSlot): ArticleWorkflowImageRole => slot === "cover" ? "cover" : "inline";

export function createPlannedArticleImage(args: {
  readonly slot: ArticleWorkflowImageSlot;
  readonly prompt: string;
  readonly alt?: string;
  readonly caption?: string;
}): ArticleWorkflowImageAsset {
  return {
    slot: args.slot,
    role: roleFor(args.slot),
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
  const bySlot = new Map(current.map((image) => [image.slot, image] as const));
  const merged = planned.map((image) => {
    const old = bySlot.get(image.slot);
    return old ? {
      ...image,
      assetId: old.assetId,
      imageUrl: old.imageUrl,
      thumbnailUrl: old.thumbnailUrl,
      alt: image.alt.trim() || old.alt,
      caption: image.caption.trim() || old.caption,
      prompt: image.prompt.trim() || old.prompt,
    } : image;
  });
  const slots = new Set(merged.map((image) => image.slot));
  return [...merged, ...current.filter((image) => !slots.has(image.slot))]
    .sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));
}

export function findArticleImageBySlot(
  manifest: readonly ArticleWorkflowImageAsset[],
  slot: ArticleWorkflowImageSlot,
): ArticleWorkflowImageAsset | null {
  return manifest.find((image) => image.slot === slot) ?? null;
}

function imageSection(document: any, image: ArticleWorkflowImageAsset): any {
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
  img.setAttribute("style", "display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:12px;");
  section.appendChild(img);
  return section;
}

function findSlot(root: any, slot: ArticleWorkflowImageSlot): any {
  const nodes = Array.from(root.getElementsByTagName("*") as any[]);
  return nodes.find((node) => node.tagName.toLowerCase() === "section" &&
    node.getAttribute("data-ai-assistant-image-slot") === slot) ??
    nodes.find((node) => node.getAttribute("data-ai-assistant-image-slot") === slot) ?? null;
}

export function applyArticleImageManifestToHtml(
  bodyHtml: string,
  imageManifest: readonly ArticleWorkflowImageAsset[],
): string {
  const document = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return bodyHtml;
  for (const image of imageManifest.filter((item) => item.imageUrl.trim())) {
    const next = imageSection(document, image);
    const old = findSlot(body, image.slot);
    if (old?.parentNode) old.parentNode.replaceChild(next, old);
    else body.appendChild(next);
  }
  return Array.from(body.childNodes as unknown as any[]).map((node) => serializer.serializeToString(node)).join("").trim();
}
