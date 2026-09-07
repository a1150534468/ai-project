import { describe, expect, it } from "vitest";
import {
  buildCurrentUserContent,
  isImageMime,
  prepareChatAttachments,
  resolveChatModel,
  supportsVisionModel,
  type ChatAttachmentPayload,
} from "./attachments.js";

function attachment(
  name: string,
  content: string | Buffer,
  overrides: Partial<ChatAttachmentPayload> = {},
): ChatAttachmentPayload {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    name,
    mime: "text/plain",
    sizeBytes: bytes.length,
    kind: "file",
    dataBase64: bytes.toString("base64"),
    ...overrides,
  };
}

function textBody(block: unknown): string {
  if (
    !block ||
    typeof block !== "object" ||
    !("type" in block) ||
    block.type !== "text" ||
    !("text" in block) ||
    typeof block.text !== "string"
  ) {
    throw new Error("expected a text attachment block");
  }
  const text = block.text;
  return text.slice(text.indexOf("\n\n") + 2);
}

describe("chat model selection", () => {
  it("keeps text-only and vision-capable model choices", () => {
    expect(resolveChatModel("glm-5.2", false)).toEqual({
      model: "glm-5.2",
      requestedModel: "glm-5.2",
      fallbackReason: null,
    });
    expect(resolveChatModel("qwen3.5-ocr", true).model).toBe("qwen3.5-ocr");
    expect(supportsVisionModel("GPT-4o-mini")).toBe(true);
  });

  it("moves image turns to the configured vision fallback", () => {
    expect(resolveChatModel("deepseek-v4-pro", true, "qwen3.5-omni-plus")).toEqual({
      model: "qwen3.5-omni-plus",
      requestedModel: "deepseek-v4-pro",
      fallbackReason: "image_requires_multimodal",
    });
  });
});

describe("chat attachment preparation", () => {
  it("returns an empty preparation without changing plain user content", async () => {
    const prepared = await prepareChatAttachments();

    expect(prepared).toEqual({
      blocks: [],
      storedLabel: "",
      searchableText: "",
      hasImage: false,
      imageCount: 0,
    });
    expect(buildCurrentUserContent(" hello ", prepared)).toBe(" hello ");
  });

  it("parses files into model context and a compact stored label", async () => {
    const prepared = await prepareChatAttachments([attachment("note.txt", "hello world")]);

    expect(prepared.hasImage).toBe(false);
    expect(prepared.storedLabel).toBe("\n\n[附件]\n- note.txt（文件，1KB）");
    expect(prepared.searchableText).toBe("附件文件：note.txt\n\nhello world");
    expect(buildCurrentUserContent("总结", prepared)).toEqual([
      { type: "text", text: "总结" },
      { type: "text", text: "附件文件：note.txt\n\nhello world" },
    ]);
  });

  it("normalizes supported image MIME types and preserves image bytes", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const prepared = await prepareChatAttachments([
      attachment("paste.png", bytes, { mime: " IMAGE/PNG ", kind: "image" }),
    ]);

    expect(isImageMime("Image/PNG")).toBe(true);
    expect(prepared.hasImage).toBe(true);
    expect(prepared.imageCount).toBe(1);
    expect(prepared.blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
    expect(buildCurrentUserContent("", prepared)?.[0]).toEqual({
      type: "text",
      text: "请根据附件内容回答。",
    });
  });

  it("rejects malformed Base64 instead of accepting a decoded prefix", async () => {
    const payload = attachment("broken.txt", "hello");
    payload.dataBase64 = `${payload.dataBase64}ignored`;

    await expect(prepareChatAttachments([payload])).rejects.toThrow("附件 broken.txt 的 Base64 内容不合法");
  });

  it("checks the decoded byte count against client metadata", async () => {
    const payload = attachment("wrong-size.txt", "hello", { sizeBytes: 4 });

    await expect(prepareChatAttachments([payload])).rejects.toThrow("附件 wrong-size.txt 的实际大小与声明不一致");
  });

  it("rejects image kinds whose MIME cannot be sent to the model", async () => {
    const payload = attachment("vector.svg", "<svg/>", {
      kind: "image",
      mime: "image/svg+xml",
    });

    await expect(prepareChatAttachments([payload])).rejects.toThrow("不支持的图片类型：image/svg+xml");
  });

  it("counts the truncation notice inside each file's 12,000 character limit", async () => {
    const prepared = await prepareChatAttachments([attachment("long.txt", "x".repeat(12_500))]);
    const content = textBody(prepared.blocks[0]);

    expect(content).toHaveLength(12_000);
    expect(content).toMatch(/\[内容已截断，原文过长\]$/);
  });

  it("never allocates more than 24,000 extracted characters across files", async () => {
    const prepared = await prepareChatAttachments([
      attachment("one.txt", "a".repeat(15_000)),
      attachment("two.txt", "b".repeat(15_000)),
      attachment("three.txt", "c".repeat(100)),
    ]);
    const contents = prepared.blocks.map(textBody);

    expect(contents.map((content) => content.length)).toEqual([12_000, 12_000, 0]);
    expect(contents.reduce((sum, content) => sum + content.length, 0)).toBe(24_000);
  });

  it("enforces the 20MB request limit using decoded bytes", async () => {
    const tenMb = Buffer.alloc(10 * 1024 * 1024, 1);
    const oneByte = Buffer.from([1]);

    await expect(
      prepareChatAttachments([
        attachment("one.png", tenMb, { mime: "image/png", kind: "image" }),
        attachment("two.png", tenMb, { mime: "image/png", kind: "image" }),
        attachment("extra.png", oneByte, { mime: "image/png", kind: "image" }),
      ]),
    ).rejects.toThrow("附件总大小超过 20MB 限制");
  });
});
