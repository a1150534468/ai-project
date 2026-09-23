// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MODEL_OPTIONS } from "../../workflowState";
import { EcomMainImageStudio } from "./EcomMainImageStudio";

afterEach(cleanup);

describe("EcomMainImageStudio without retired pricing UI", () => {
  it("loads history and submits the selected model without requesting unused pricing", async () => {
    const client = {
      getEcomMainPricing: vi.fn(),
      getCurrentEcomMainJob: vi.fn().mockResolvedValue({ job: null }),
      createEcomMainJob: vi.fn().mockRejectedValue(new Error("测试生成失败")),
      redrawEcomMainImage: vi.fn(),
    };
    const shared = {
      platformId: "taobao",
      productName: "陶瓷餐盘",
      category: "餐厨",
      sellingPointsInput: "耐高温",
      extra: "",
      referenceAssetIds: [],
    };
    render(<EcomMainImageStudio token="test-token" shared={shared} client={client} />);
    await waitFor(() => expect(client.getCurrentEcomMainJob).toHaveBeenCalledWith("test-token"));

    const nextModel = IMAGE_MODEL_OPTIONS[1];
    fireEvent.click(screen.getByRole("button", { name: IMAGE_MODEL_OPTIONS[0].label }));
    fireEvent.click(screen.getByRole("option", { name: nextModel.label }));
    fireEvent.click(screen.getByRole("button", { name: "生成主图" }));

    await waitFor(() => expect(client.createEcomMainJob).toHaveBeenCalledWith(
      "test-token",
      expect.objectContaining({ model: nextModel.value, product: expect.objectContaining({ name: shared.productName }) }),
    ));
    expect(await screen.findByText("测试生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成主图" })).toBeEnabled();
    expect(client.getEcomMainPricing).not.toHaveBeenCalled();
  });
});
