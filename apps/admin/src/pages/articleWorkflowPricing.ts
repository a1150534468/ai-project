import type { EcomResourcePricingConfig } from "./ResourcePricingPanels.js";

export const ARTICLE_WORKFLOW_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    resourceKey: "article_workflow_text_output",
    title: "公众号图文生成价格",
    description: "按正文字数计费，适用于首轮生成与 AI 重新生成。",
    displayName: "公众号图文生成",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每千字扣点",
  },
];
