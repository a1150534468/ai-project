// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { articleWorkflowPlatformConfig } from "@ai-assistant/article-workflow";
import { ArticleWorkflowResultTools } from "./ArticleWorkflowResultSidebar";

describe("ArticleWorkflowResultTools image scope", () => {
  it("uses the main action for the current platform and the menu for the whole batch", () => {
    const onGenerateImages = vi.fn();
    render(
      <ArticleWorkflowResultTools
        project={{
          id: "p-1",
          creationMode: "topic",
          creationConfig: { mode: "topic", generateImages: false, topic: "冰咖啡", keyPoints: "", audience: "", avoid: "", style: { mode: "preset", preset: "general" } },
          sourceFormat: "plain-text",
          sourceText: "创作主题：冰咖啡",
          generationMode: "polish-text",
          platform: "xiaohongshu",
          batchId: "b-1",
          theme: "auto",
          themeColor: null,
          galleryMode: "collage",
          title: "冰咖啡",
          summary: "",
          bodyHtml: "",
          bodyMarkdown: "",
          captionText: "先确认文案。",
          tags: ["冰咖啡"],
          imageManifestJson: [{ slot: "cover", role: "cover", assetId: null, imageUrl: "", thumbnailUrl: "", alt: "封面", caption: "", prompt: "cover prompt" }],
          status: "ready",
          progressStage: "ready",
          progressPercent: 100,
          progressMessage: "文案已生成",
          error: null,
          createdAt: "2026-07-30T08:00:00.000Z",
          updatedAt: "2026-07-30T08:00:00.000Z",
        }}
        platformConfig={articleWorkflowPlatformConfig("xiaohongshu")}
        rewriteInstruction=""
        rewriteGenerationMode="polish-text"
        rewriteRegenerateImages={false}
        rewriting={false}
        retryingProjectId={null}
        regeneratingSlot={null}
        canRewrite={false}
        batchMissingProjectCount={3}
        generatingImages={false}
        canGenerateImages
        onRewriteInstructionChange={() => undefined}
        onRewriteGenerationModeChange={() => undefined}
        onRewriteRegenerateImagesChange={() => undefined}
        onRewrite={() => undefined}
        onRetry={() => undefined}
        onRegenerateImage={() => undefined}
        onGenerateImages={onGenerateImages}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成配图" }));
    expect(onGenerateImages).toHaveBeenLastCalledWith("current");

    fireEvent.click(screen.getByRole("button", { name: "选择配图生成范围" }));
    fireEvent.click(screen.getByRole("button", { name: "生成全部平台配图" }));
    expect(onGenerateImages).toHaveBeenLastCalledWith("batch");
  });
});
