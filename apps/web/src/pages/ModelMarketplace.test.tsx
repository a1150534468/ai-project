import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelCard } from "./ModelMarketplace";
import type { ModelMarketplaceRow } from "../api";

function marketplaceModel(overrides: Partial<ModelMarketplaceRow> = {}): ModelMarketplaceRow {
  return {
    model: "claude-opus-4-8",
    displayName: "Claude/opus 4.8",
    enabled: true,
    description: "适合复杂代码生成和工程理解。",
    tags: "coding",
    contextLength: 0,
    useCases: "AI 编程 / 代码生成",
    sortOrder: 1,
    showInMarketplace: true,
    inputPricePerMillion: 800,
    outputPricePerMillion: 4500,
    cacheInputPricePerMillion: 0,
    cacheOutputPricePerMillion: 0,
    inputPriceRmbPerMillion: 8,
    outputPriceRmbPerMillion: 45,
    cacheInputPriceRmbPerMillion: 0,
    cacheOutputPriceRmbPerMillion: 0,
    vipInputPrice: { original: 800, discounted: 800 },
    vipOutputPrice: { original: 4500, discounted: 4500 },
    vipCacheInputPrice: { original: 0, discounted: 0 },
    vipCacheOutputPrice: { original: 0, discounted: 0 },
    ...overrides,
  };
}

describe("ModelCard", () => {
  it("does not render the internal model id", () => {
    const html = renderToStaticMarkup(<ModelCard model={marketplaceModel()} />);

    expect(html).toContain("Claude/opus 4.8");
    expect(html).not.toContain("claude-opus-4-8");
  });

  it("labels free quota and OpenAI-only models without presenting them as chat options", () => {
    const html = renderToStaticMarkup(<ModelCard model={marketplaceModel({
      tags: "reasoning,preview,free-quota,openai-only",
    })} />);

    expect(html).toContain("免费额度");
    expect(html).toContain("预览版");
    expect(html).toContain("仅 OpenAI 接口");
    expect(html).not.toContain("对话可用");
  });

  it("keeps the free-quota label visible when a model has many capability tags", () => {
    const html = renderToStaticMarkup(<ModelCard model={marketplaceModel({
      tags: "chat,coding,reasoning,vision,tool-use,free-quota,anthropic",
    })} />);

    expect(html).toContain("免费额度");
  });
});
