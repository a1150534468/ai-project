import type Anthropic from "@anthropic-ai/sdk";
import { parseDocument } from "../kb/parse.js";

export type ChatAttachmentKind = "image" | "file";

export interface ChatAttachmentPayload {
  name: string;
  mime: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  dataBase64: string;
}

export interface PreparedChatAttachments {
  blocks: Anthropic.ContentBlockParam[];
  storedLabel: string;
  searchableText: string;
  hasImage: boolean;
  imageCount: number;
}

const MULTIMODAL_FALLBACK_MODEL = "qwen3.7-plus";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_TEXT_CHARS = 12_000;
const MAX_TOTAL_FILE_TEXT_CHARS = 24_000;

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[内容已截断，原文过长]`;
}

function decodedBuffer(attachment: ChatAttachmentPayload): Buffer {
  const buf = Buffer.from(attachment.dataBase64, "base64");
  if (buf.length === 0) throw new Error(`附件 ${attachment.name} 内容为空`);
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`附件 ${attachment.name} 超过 10MB 限制`);
  return buf;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

export function supportsVisionModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return [
    "minimax-m3",
    "m3",
    "vision",
    "vl",
    "omni",
    "qwen3.7-plus",
    "kimi-k2.7-code",
    "glm-4v",
    "gpt-4o",
    "gemini",
    "qwen-vl",
    "claude-3",
  ].some((keyword) => normalized.includes(keyword));
}

export function resolveChatModel(
  requestedModel: string,
  hasImage: boolean,
  multimodalFallback = process.env.CHAT_MULTIMODAL_MODEL?.trim() || MULTIMODAL_FALLBACK_MODEL,
) {
  if (hasImage && !supportsVisionModel(requestedModel)) {
    return {
      model: multimodalFallback,
      requestedModel,
      fallbackReason: "image_requires_multimodal" as const,
    };
  }
  return { model: requestedModel, requestedModel, fallbackReason: null };
}

export async function prepareChatAttachments(
  attachments: ChatAttachmentPayload[] = [],
): Promise<PreparedChatAttachments> {
  if (attachments.length === 0) {
    return { blocks: [], storedLabel: "", searchableText: "", hasImage: false, imageCount: 0 };
  }

  let totalBytes = 0;
  let totalFileTextChars = 0;
  let imageCount = 0;
  const blocks: Anthropic.ContentBlockParam[] = [];
  const labels: string[] = [];
  const searchableParts: string[] = [];

  for (const attachment of attachments) {
    const mime = attachment.mime.toLowerCase();
    const buf = decodedBuffer(attachment);
    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("附件总大小超过 20MB 限制");

    const isImage = attachment.kind === "image" || isImageMime(mime);
    labels.push(`- ${attachment.name}（${isImage ? "图片" : "文件"}，${Math.ceil(buf.length / 1024)}KB）`);

    if (isImage) {
      if (!isImageMime(mime)) throw new Error(`不支持的图片类型：${attachment.mime}`);
      imageCount += 1;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: attachment.dataBase64,
        },
      } as Anthropic.ContentBlockParam);
      searchableParts.push(`[图片附件：${attachment.name}]`);
      continue;
    }

    const text = await parseDocument(buf, attachment.mime, attachment.name);
    const remaining = Math.max(0, MAX_TOTAL_FILE_TEXT_CHARS - totalFileTextChars);
    const clipped = clampText(text, Math.min(MAX_FILE_TEXT_CHARS, remaining));
    totalFileTextChars += clipped.length;
    const fileBlock = `附件文件：${attachment.name}\n\n${clipped}`;
    blocks.push({ type: "text", text: fileBlock });
    searchableParts.push(fileBlock);
  }

  return {
    blocks,
    storedLabel: labels.length > 0 ? `\n\n[附件]\n${labels.join("\n")}` : "",
    searchableText: searchableParts.join("\n\n"),
    hasImage: imageCount > 0,
    imageCount,
  };
}

export function buildCurrentUserContent(
  message: string,
  prepared: PreparedChatAttachments,
): Anthropic.MessageParam["content"] {
  if (prepared.blocks.length === 0) return message;
  return [
    {
      type: "text",
      text: message.trim() || "请根据附件内容回答。",
    },
    ...prepared.blocks,
  ];
}

export function estimateInputTokens(message: string, prepared: PreparedChatAttachments): number {
  const textTokens = Math.ceil(`${message}\n${prepared.searchableText}`.length / 3);
  return textTokens + prepared.imageCount * 1000;
}
