import {
  ARTICLE_WORKFLOW_IMAGE_SLOTS,
  type ArticleWorkflowPlatformConfig,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowPlan } from "./article-workflow-schema.js";

/** 从正文里兜一个标题：取首个非空行，去掉 Markdown 标题标记与结尾标点。 */
export function articleWorkflowTitleFromBody(bodyMarkdown: string, limit: number): string {
  const firstLine = bodyMarkdown
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const stripped = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  if (!stripped) return "";
  if (stripped.length <= limit) return stripped.replace(/[，。、；：,.;:]+$/u, "");
  // 首行过长时在句读处收尾，避免把标题截成半句。
  const head = stripped.slice(0, limit);
  const breakAt = Math.max(
    head.lastIndexOf("，"),
    head.lastIndexOf("。"),
    head.lastIndexOf("；"),
    head.lastIndexOf("、"),
    head.lastIndexOf(","),
    head.lastIndexOf("."),
  );
  if (breakAt >= Math.floor(limit * 0.5)) return head.slice(0, breakAt);
  return head;
}

function normalizeImages(
  images: ArticleWorkflowPlan["images"],
  config: ArticleWorkflowPlatformConfig,
): ArticleWorkflowPlan["images"] {
  // 与 caption 链路一致：强制首张 cover、其余按顺序补 inline-n。
  return images.slice(0, config.maxImages).map((image, index) => ({
    ...image,
    slot: ARTICLE_WORKFLOW_IMAGE_SLOTS[index]!,
    role: index === 0 ? ("cover" as const) : ("inline" as const),
  }));
}

/**
 * 把 LLM 产出的 html-fragment 计划归一化到平台约束内。
 *
 * 与 normalizeArticleWorkflowCaptionPlan 同样的取舍：一律归一化，不抛错。
 * 正文与配图都齐了却因为缺个标题整单失败，用户要白付一次文本费再重跑一遍。
 * 实测 preserve-text 模式下模型会守着「不增删正文」交回空 title（素材无独立标题时），
 * 提示词已修，这里是第二道兜底。
 */
export function normalizeArticleWorkflowPlan(args: {
  readonly plan: ArticleWorkflowPlan;
  readonly config: ArticleWorkflowPlatformConfig;
}): ArticleWorkflowPlan {
  const { plan, config } = args;
  const title = plan.title.trim()
    || articleWorkflowTitleFromBody(plan.bodyMarkdown, config.titleMaxLength)
    || "未命名图文";
  return {
    title: title.slice(0, config.titleMaxLength),
    summary: plan.summary.trim(),
    bodyMarkdown: plan.bodyMarkdown,
    images: normalizeImages(plan.images, config),
  };
}
