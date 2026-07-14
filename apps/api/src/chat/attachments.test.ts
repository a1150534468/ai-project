import { describe, expect, it } from "vitest";
import {
  buildCurrentUserContent,
  estimateInputTokens,
  prepareChatAttachments,
  resolveChatModel,
} from "./attachments.js";

describe("chat attachments", () => {
  it("falls back to Bailian qwen3.7-plus for image turns when selected model has no vision support", () => {
    expect(resolveChatModel("glm-5.2", true)).toMatchObject({
      model: "qwen3.7-plus",
      requestedModel: "glm-5.2",
      fallbackReason: "image_requires_multimodal",
    });
    expect(resolveChatModel("qwen3.7-plus", true)).toMatchObject({
      model: "qwen3.7-plus",
      fallbackReason: null,
    });
  });

  it("allows overriding the multimodal fallback for a deployed Bailian catalog", () => {
    expect(resolveChatModel("deepseek-v4-pro", true, "qwen3.5-omni-plus")).toMatchObject({
      model: "qwen3.5-omni-plus",
      fallbackReason: "image_requires_multimodal",
    });
  });

  it("converts text files into user text blocks", async () => {
    const prepared = await prepareChatAttachments([
      {
        name: "note.txt",
        mime: "text/plain",
        sizeBytes: 11,
        kind: "file",
        dataBase64: Buffer.from("hello world").toString("base64"),
      },
    ]);

    expect(prepared.hasImage).toBe(false);
    expect(prepared.storedLabel).toContain("note.txt");
    expect(prepared.searchableText).toContain("hello world");
    expect(buildCurrentUserContent("总结", prepared)).toEqual([
      { type: "text", text: "总结" },
      { type: "text", text: expect.stringContaining("hello world") },
    ]);
    expect(estimateInputTokens("总结", prepared)).toBeGreaterThan(0);
  });

  it("keeps images as image blocks and counts vision token estimate", async () => {
    const prepared = await prepareChatAttachments([
      {
        name: "paste.png",
        mime: "image/png",
        sizeBytes: 4,
        kind: "image",
        dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      },
    ]);

    expect(prepared.hasImage).toBe(true);
    expect(prepared.imageCount).toBe(1);
    expect(prepared.blocks[0]).toMatchObject({ type: "image" });
    expect(estimateInputTokens("", prepared)).toBeGreaterThanOrEqual(1000);
  });
});
