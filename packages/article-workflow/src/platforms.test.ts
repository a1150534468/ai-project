import { describe, expect, it } from "vitest";
import {
  ARTICLE_WORKFLOW_PLATFORM_CONFIGS,
  articleWorkflowPlatformConfig,
  isCaptionPlatform,
  resolveArticleWorkflowMode,
} from "./platforms.js";
import { ARTICLE_WORKFLOW_PLATFORMS } from "./types.js";

describe("article workflow platforms", () => {
  it("每个平台都有配置，且 key 与 platform 字段一致", () => {
    for (const platform of ARTICLE_WORKFLOW_PLATFORMS) {
      expect(ARTICLE_WORKFLOW_PLATFORM_CONFIGS[platform].platform).toBe(platform);
    }
  });

  it("公众号出 HTML 片段，横版封面 + 4:3 内页", () => {
    const config = articleWorkflowPlatformConfig("wechat");
    expect(config.outputKind).toBe("html-fragment");
    expect(config.coverSize).toBe("1536x864");
    expect(config.inlineSize).toBe("1024x768");
  });

  it("小红书出文案，竖版 3:4", () => {
    const config = articleWorkflowPlatformConfig("xiaohongshu");
    expect(config.outputKind).toBe("caption");
    expect(config.coverSize).toBe("768x1024");
    expect(config.inlineSize).toBe("768x1024");
    expect(config.titleMaxLength).toBe(20);
  });

  it("抖音出文案，竖版 9:16", () => {
    const config = articleWorkflowPlatformConfig("douyin");
    expect(config.outputKind).toBe("caption");
    expect(config.coverSize).toBe("864x1536");
    expect(config.inlineSize).toBe("864x1536");
  });

  it("未知平台回落公众号", () => {
    expect(articleWorkflowPlatformConfig("bilibili").platform).toBe("wechat");
    expect(articleWorkflowPlatformConfig(null).platform).toBe("wechat");
    expect(articleWorkflowPlatformConfig(undefined).platform).toBe("wechat");
  });

  it("isCaptionPlatform 只对 caption 平台为真", () => {
    expect(isCaptionPlatform("wechat")).toBe(false);
    expect(isCaptionPlatform("xiaohongshu")).toBe(true);
    expect(isCaptionPlatform("douyin")).toBe(true);
    expect(isCaptionPlatform("unknown")).toBe(false);
  });

  it("caption 平台的 preserve-text 静默降级为 polish-text", () => {
    expect(resolveArticleWorkflowMode("xiaohongshu", "preserve-text")).toBe("polish-text");
    expect(resolveArticleWorkflowMode("douyin", "preserve-text")).toBe("polish-text");
  });

  it("公众号保留两种模式原样", () => {
    expect(resolveArticleWorkflowMode("wechat", "preserve-text")).toBe("preserve-text");
    expect(resolveArticleWorkflowMode("wechat", "polish-text")).toBe("polish-text");
  });

  it("所有平台的图片上限都在 1..5 之间", () => {
    for (const platform of ARTICLE_WORKFLOW_PLATFORMS) {
      const { maxImages } = ARTICLE_WORKFLOW_PLATFORM_CONFIGS[platform];
      expect(maxImages).toBeGreaterThanOrEqual(1);
      expect(maxImages).toBeLessThanOrEqual(5);
    }
  });
});
