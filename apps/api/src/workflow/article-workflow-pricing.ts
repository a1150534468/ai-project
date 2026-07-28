import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowOutputKind,
  type ArticleWorkflowPlatform,
} from "@ai-assistant/article-workflow";
import { resolveImagePricing, resolveResourcePrice, type ResourcePriceLister, type WorkflowResourcePriceRow } from "./workflow-pricing.js";
import { ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY } from "./article-workflow-shared.js";

export const DEFAULT_ARTICLE_WORKFLOW_TEXT_PRICE: WorkflowResourcePriceRow = {
  resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
  // 只是兜底展示名；resourceKey 是 billing 侧取价的键，不能动
  displayName: "多平台图文文本生成",
  pricingType: "PER_UNIT",
  rate: 1,
  perUnits: 1000,
  enabled: true,
};

export interface ArticleWorkflowPlatformPricing {
  readonly platform: ArticleWorkflowPlatform;
  readonly label: string;
  readonly outputKind: ArticleWorkflowOutputKind;
  readonly maxImages: number;
}

export interface ArticleWorkflowPricing {
  readonly text: WorkflowResourcePriceRow;
  readonly image1k: WorkflowResourcePriceRow;
  /** 旧字段，前端过渡期还在读；按平台的上限见 platforms */
  readonly maxImages: number;
  readonly platforms: readonly ArticleWorkflowPlatformPricing[];
}

export async function resolveArticleWorkflowPricing(billing: ResourcePriceLister): Promise<ArticleWorkflowPricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  const image = await resolveImagePricing(billing);
  return {
    text: resolveResourcePrice(rows, DEFAULT_ARTICLE_WORKFLOW_TEXT_PRICE),
    image1k: image["1K"],
    maxImages: 5,
    platforms: ARTICLE_WORKFLOW_PLATFORMS.map((platform) => {
      const config = articleWorkflowPlatformConfig(platform);
      return {
        platform,
        label: config.label,
        outputKind: config.outputKind,
        maxImages: config.maxImages,
      };
    }),
  };
}
