import {
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  type ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowCaptionPlan } from "./article-workflow-schema.js";

/** 在不超过 limit 的前提下尽量在换行处收尾，避免把最后一段截成半句。 */
function truncateAtBoundary(value: string, limit: number): string {
  if (limit <= 0 || value.length <= limit) return value;
  const head = value.slice(0, limit);
  const lastBreak = head.lastIndexOf("\n");
  // 只有当换行点还留下大部分内容时才在那里切，否则宁可硬截。
  if (lastBreak >= Math.floor(limit * 0.6)) return head.slice(0, lastBreak).trimEnd();
  return head.trimEnd();
}

function normalizeTags(tags: readonly string[], config: ArticleWorkflowPlatformConfig): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= config.maxTags) break;
  }
  return result;
}

function normalizeImages(
  images: ArticleWorkflowCaptionPlan["images"],
  config: ArticleWorkflowPlatformConfig,
): ArticleWorkflowCaptionPlan["images"] {
  // 强制首张为 cover、其余按顺序补 inline-n，LLM 给错 slot 顺序也能落地。
  return images.slice(0, config.maxImages).map((image, index) => ({
    ...image,
    slot: ARTICLE_WORKFLOW_IMAGE_SLOTS[index],
    role: index === 0 ? ("cover" as const) : ("inline" as const),
  }));
}

/**
 * 把 LLM 产出的 caption 计划裁剪到平台硬限制内。
 *
 * 一律归一化，不抛错：LLM 超字数是常态，为此整单失败会让用户白付一次文本费。
 */
export function normalizeArticleWorkflowCaptionPlan(args: {
  readonly plan: ArticleWorkflowCaptionPlan;
  readonly config: ArticleWorkflowPlatformConfig;
}): ArticleWorkflowCaptionPlan {
  const { plan, config } = args;
  return {
    title: truncateAtBoundary(plan.title.trim(), config.titleMaxLength),
    captionText: truncateAtBoundary(plan.captionText.trim(), config.captionMaxLength),
    tags: normalizeTags(plan.tags, config),
    images: normalizeImages(plan.images, config),
  };
}

/** caption 项目的列表页/历史侧栏摘要：取首行前 100 字。 */
export function articleWorkflowCaptionSummary(captionText: string): string {
  const firstLine = captionText.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.slice(0, 100);
}
