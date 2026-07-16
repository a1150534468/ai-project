import { describe, expect, it, vi } from "vitest";
import { resolveEcomMainImagePricing, resolveEcomPricing, resolveImagePricing, resolveResourcePrice, type WorkflowResourcePriceRow } from "./workflow-pricing.js";

const overrideRow = (resourceKey: string, rate: number): WorkflowResourcePriceRow => ({
  resourceKey,
  displayName: `覆盖-${resourceKey}`,
  pricingType: "PER_UNIT",
  rate,
  perUnits: 1,
  enabled: true,
});

describe("resolveResourcePrice", () => {
  it("命中后台费率时合并覆盖，resourceKey 以默认值为准", () => {
    const fallback = overrideRow("image_generation_1k", 10);
    const merged = resolveResourcePrice([{ ...overrideRow("image_generation_1k", 99), resourceKey: "image_generation_1k" }], fallback);
    expect(merged.rate).toBe(99);
    expect(merged.resourceKey).toBe("image_generation_1k");
  });

  it("未命中时回落默认值", () => {
    const fallback = overrideRow("image_generation_2k", 20);
    expect(resolveResourcePrice([overrideRow("other", 1)], fallback)).toEqual(fallback);
  });
});

describe("resolveImagePricing", () => {
  it("billing 无 listResourcePrices 时返回三档默认价", async () => {
    const pricing = await resolveImagePricing({});
    expect(pricing["1K"].rate).toBe(10);
    expect(pricing["2K"].rate).toBe(20);
    expect(pricing["4K"].rate).toBe(40);
    expect(pricing["1K"].resourceKey).toBe("image_generation_1k");
  });

  it("后台费率覆盖默认价", async () => {
    const listResourcePrices = vi.fn(async () => ({ data: [overrideRow("image_generation_4k", 88)] }));
    const pricing = await resolveImagePricing({ listResourcePrices });
    expect(pricing["4K"].rate).toBe(88);
    expect(pricing["1K"].rate).toBe(10);
  });
});

describe("resolveEcomPricing", () => {
  it("无 listResourcePrices 时母版/分段/拼接回落默认", async () => {
    const pricing = await resolveEcomPricing({});
    expect(pricing.master["1K"].rate).toBe(10);
    expect(pricing.segment["4K"].rate).toBe(40);
    expect(pricing.stitch.rate).toBe(1);
    expect(pricing.master["2K"].resourceKey).toBe("image_generation_2k");
    expect(pricing.segment["2K"].resourceKey).toBe("image_generation_2k");
    expect(pricing.stitch.resourceKey).toBe("ecom_stitch");
  });

  it("后台费率覆盖对应资源", async () => {
    const listResourcePrices = vi.fn(async () => ({
      data: [overrideRow("image_generation_1k", 15), overrideRow("ecom_stitch", 5)],
    }));
    const pricing = await resolveEcomPricing({ listResourcePrices });
    expect(pricing.master["1K"].rate).toBe(15);
    expect(pricing.master["2K"].rate).toBe(20);
    expect(pricing.stitch.rate).toBe(5);
  });
});

describe("resolveEcomMainImagePricing", () => {
  it("无 billing 覆盖时回落默认 10/20/40", async () => {
    const pricing = await resolveEcomMainImagePricing({});
    expect(pricing["1K"].resourceKey).toBe("image_generation_1k");
    expect(pricing["1K"].rate).toBe(10);
    expect(pricing["2K"].rate).toBe(20);
    expect(pricing["4K"].rate).toBe(40);
  });

  it("后台覆盖费率生效但 resourceKey 以默认为准", async () => {
    const listResourcePrices = vi.fn(async () => ({
      data: [overrideRow("image_generation_2k", 99)],
    }));
    const pricing = await resolveEcomMainImagePricing({ listResourcePrices });
    expect(pricing["2K"].rate).toBe(99);
    expect(pricing["2K"].resourceKey).toBe("image_generation_2k");
  });
});
