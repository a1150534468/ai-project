import { describe, expect, it } from "vitest";
import {
  buildCurrentUserContent,
  estimateInputTokens,
  prepareChatAttachments,
  resolveChatModel,
} from "./attachments.js";

describe("chat attachments", () => {
  it("falls back to MiniMax-M3 for image turns when selected model has no vision support", () => {
    expect(resolveChatModel("GLM-5.2", true)).toMatchObject({
      model: "MiniMax-M3",
      requestedModel: "GLM-5.2",
      fallbackReason: "image_requires_multimodal",
    });
    expect(resolveChatModel("MiniMax-M3", true)).toMatchObject({
      model: "MiniMax-M3",
      fallbackReason: null,
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
