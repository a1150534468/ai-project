import { describe, expect, it } from "vitest";
import {
  imageGenerationResourceKey,
  imageModelResourceKey,
  imageResolutionFromSize,
  imageSizeForResolution,
  normalizeImageSize,
  upstreamImageOptions,
} from "./image-upstream-options.js";

describe("image upstream options", () => {
  it.each([
    ["1024x1024", "1:1", "1k"],
    ["2048x1152", "16:9", "2k"],
    ["2160x3840", "9:16", "4k"],
  ])("maps %s to provider ratio %s at %s", (size, ratio, resolution) => {
    expect(upstreamImageOptions(size)).toEqual({ size: ratio, resolution });
    expect(imageResolutionFromSize(size)).toBe(resolution.toUpperCase());
  });

  it("normalizes unknown sizes without changing auto", () => {
    expect(normalizeImageSize(" auto ")).toBe("auto");
    expect(normalizeImageSize("123x456")).toBe("1024x1024");
    expect(upstreamImageOptions("custom")).toEqual({ size: "custom" });
  });

  it("moves between resolution tiers while preserving aspect ratio", () => {
    expect(imageSizeForResolution("1536x864", "4K")).toBe("3840x2160");
    expect(imageSizeForResolution("auto", "2K")).toBeNull();
    expect(imageResolutionFromSize("1024x1024", " 2k ")).toBe("2K");
  });

  it("builds generic and model-specific resource keys", () => {
    expect(imageGenerationResourceKey("2K")).toBe("image_generation_2k");
    expect(imageModelResourceKey(" GPT Image 2 ", "4K"))
      .toBe("image_generation_gpt_image_2_4k");
  });
});
