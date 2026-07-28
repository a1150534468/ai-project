import type { EcomResourcePricingConfig } from "./ResourcePricingPanels.js";

export const ARTICLE_WORKFLOW_PRICING_CONFIGS: readonly EcomResourcePricingConfig[] = [
  {
    // resourceKey 是 billing 取价的键，改名只动展示文案
    resourceKey: "article_workflow_text_output",
    title: "多平台图文生成价格",
    description: "按正文字数计费，公众号 / 小红书 / 抖音每个平台各算一次，含 AI 重新生成。",
    displayName: "多平台图文文本生成",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每千字扣点",
  },
];
