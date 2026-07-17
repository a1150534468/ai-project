// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NovelModelSelector } from "./NovelModelSelector";

const listModelMarketplace = vi.hoisted(() => vi.fn());

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  listModelMarketplace,
}));

function model(model: string, displayName: string, tags: string, sortOrder: number) {
  return {
    model,
    displayName,
    enabled: true,
    description: "",
    tags,
    contextLength: 100_000,
    useCases: "长篇写作",
    sortOrder,
    showInMarketplace: true,
    inputPricePerMillion: 1,
    outputPricePerMillion: 2,
    cacheInputPricePerMillion: 0,
    cacheOutputPricePerMillion: 0,
    inputPriceRmbPerMillion: 0.01,
    outputPriceRmbPerMillion: 0.02,
    cacheInputPriceRmbPerMillion: 0,
    cacheOutputPriceRmbPerMillion: 0,
    vipInputPrice: { original: 1, discounted: 1 },
    vipOutputPrice: { original: 2, discounted: 2 },
    vipCacheInputPrice: { original: 0, discounted: 0 },
    vipCacheOutputPrice: { original: 0, discounted: 0 },
  };
}

describe("NovelModelSelector", () => {
  beforeEach(() => {
    listModelMarketplace.mockResolvedValue({
      data: [
        model("preview-only", "Preview Only", "chat,openai-only", 20),
        model("qwen3.7-plus", "Qwen3.7 Plus", "chat,anthropic", 10),
      ],
      vip: null,
    });
  });

  it("loads marketplace models and selects a novel-compatible model", async () => {
    const onChange = vi.fn();
    render(<NovelModelSelector token="token" value="" saving={false} onChange={onChange} />);

    const select = await screen.findByRole("combobox", { name: "写作模型" });
    expect(await screen.findByRole("option", { name: "Qwen3.7 Plus" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Preview Only（小说暂不支持）" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "qwen3.7-plus" } });
    expect(onChange).toHaveBeenCalledWith("qwen3.7-plus", "Qwen3.7 Plus");
  });
});
