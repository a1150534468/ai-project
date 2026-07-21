import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelCard, groupByCategory, selectVisibleGroups } from "./ModelMarketplace";
import type { ModelMarketplaceRow } from "../api";

function marketplaceModel(overrides: Partial<ModelMarketplaceRow> = {}): ModelMarketplaceRow {
  return {
    model: "claude-opus-4-8",
    displayName: "Claude/opus 4.8",
    enabled: true,
    description: "适合复杂代码生成和工程理解。",
    tags: "coding",
    category: "语言模型",
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
    imagePrice: null,
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

  it("renders per-image pricing and a generation badge for image models", () => {
    const html = renderToStaticMarkup(<ModelCard model={marketplaceModel({
      model: "doubao-seedream-4-5-251128",
      displayName: "豆包 Seedream 4.5",
      tags: "image-gen,vision",
      category: "视觉模型",
      imagePrice: { originalPoints: 20, discountedPoints: 16, resolution: "2K" },
    })} />);

    expect(html).toContain("生图可用");
    expect(html).toContain("生图（按次计费）");
    expect(html).toContain("2K");
    expect(html).toContain("16");
    expect(html).not.toContain("对话可用");
  });
});

describe("marketplace grouping and tab switching", () => {
  const rows: ModelMarketplaceRow[] = [
    marketplaceModel({ model: "gpt", displayName: "GPT", category: "语言模型" }),
    marketplaceModel({ model: "doubao", displayName: "豆包", category: "视觉模型", tags: "image-gen,vision", imagePrice: { originalPoints: 20, discountedPoints: 16, resolution: "2K" } }),
    marketplaceModel({ model: "embedding", displayName: "Embedding", category: "向量模型" }),
  ];
  const groups = groupByCategory(rows);

  it("groups models by their category in the fixed display order", () => {
    expect(groups.map((group) => group.category)).toEqual(["语言模型", "视觉模型", "向量模型"]);
  });

  it('shows every group when the "全部" tab is active', () => {
    expect(selectVisibleGroups(groups, "全部")).toHaveLength(3);
  });

  it("narrows to a single category when its tab is selected", () => {
    const visible = selectVisibleGroups(groups, "视觉模型");
    expect(visible).toHaveLength(1);
    expect(visible[0]!.category).toBe("视觉模型");
    expect(visible[0]!.rows.map((row) => row.model)).toEqual(["doubao"]);
  });

  it("returns an empty list when the active category has no models", () => {
    expect(selectVisibleGroups(groups, "语音模型")).toHaveLength(0);
  });
});
