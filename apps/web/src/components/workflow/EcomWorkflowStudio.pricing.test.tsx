// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EcomWorkflowStudio } from "./EcomWorkflowStudio";

afterEach(cleanup);

describe("EcomWorkflowStudio without retired pricing UI", () => {
  it("keeps bootstrapping and generation independent of the unused pricing query", async () => {
    const client = {
      getWorkflowEcomPricing: vi.fn(),
      getWorkflowEcomOptions: vi.fn().mockResolvedValue({ platforms: [], templates: [] }),
      getCurrentWorkflowEcom: vi.fn().mockResolvedValue(null),
      createWorkflowEcomReference: vi.fn(),
      createWorkflowEcomMaster: vi.fn().mockRejectedValue(new Error("测试母版生成失败")),
      retryWorkflowEcomMaster: vi.fn(),
      confirmWorkflowEcomSegments: vi.fn(),
      redrawWorkflowEcomSegment: vi.fn(),
      stitchWorkflowEcom: vi.fn(),
      adoptWorkflowEcomMaster: vi.fn(),
    };
    render(<EcomWorkflowStudio token="test-token" client={client} shared={{
      platformId: "taobao",
      productName: "陶瓷餐盘",
      category: "餐厨",
      sellingPointsInput: "耐高温",
      extra: "",
      referenceAssets: [],
      remoteReferenceCount: 0,
    }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "生成母版" })).toBeEnabled());
    expect(client.getWorkflowEcomOptions).toHaveBeenCalledWith("test-token");
    expect(client.getCurrentWorkflowEcom).toHaveBeenCalledWith("test-token");
    fireEvent.click(screen.getByRole("button", { name: "生成母版" }));

    await waitFor(() => expect(client.createWorkflowEcomMaster).toHaveBeenCalledWith(
      "test-token",
      expect.objectContaining({ product: expect.objectContaining({ name: "陶瓷餐盘" }) }),
    ));
    expect(await screen.findByText("测试母版生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成母版" })).toBeEnabled();
    expect(client.getWorkflowEcomPricing).not.toHaveBeenCalled();
  });
});
