import { resolveImagePricing, resolveResourcePrice, type ResourcePriceLister, type WorkflowResourcePriceRow } from "./workflow-pricing.js";
import { ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY } from "./article-workflow-shared.js";

export const DEFAULT_ARTICLE_WORKFLOW_TEXT_PRICE: WorkflowResourcePriceRow = {
  resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
  displayName: "公众号图文生成",
  pricingType: "PER_UNIT",
  rate: 1,
  perUnits: 1000,
  enabled: true,
};

export interface ArticleWorkflowPricing {
  readonly text: WorkflowResourcePriceRow;
  readonly image1k: WorkflowResourcePriceRow;
  readonly maxImages: number;
}

export async function resolveArticleWorkflowPricing(billing: ResourcePriceLister): Promise<ArticleWorkflowPricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  const image = await resolveImagePricing(billing);
  return {
    text: resolveResourcePrice(rows, DEFAULT_ARTICLE_WORKFLOW_TEXT_PRICE),
    image1k: image["1K"],
    maxImages: 5,
  };
}
