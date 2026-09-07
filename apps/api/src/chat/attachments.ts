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

const DEFAULT_VISION_MODEL = "qwen3.7-plus";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_PER_FILE = 12_000;
const MAX_TEXT_PER_REQUEST = 24_000;
const TRUNCATED = "\n\n[内容已截断，原文过长]";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function truncateWithin(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit <= TRUNCATED.length) return TRUNCATED.slice(0, limit);
  return `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}

function isBase64Character(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function hasStandardBase64Shape(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const dataEnd = encoded.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64Character(encoded.charCodeAt(index))) return false;
  }
  for (let index = dataEnd; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodeAttachment(attachment: ChatAttachmentPayload): Buffer {
  const encoded = attachment.dataBase64;
  if (!hasStandardBase64Shape(encoded)) {
    throw new Error(`附件 ${attachment.name} 的 Base64 内容不合法`);
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error(`附件 ${attachment.name} 内容为空`);
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`附件 ${attachment.name} 的 Base64 内容不合法`);
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`附件 ${attachment.name} 超过 10MB 限制`);
  }
  if (bytes.length !== attachment.sizeBytes) {
    throw new Error(`附件 ${attachment.name} 的实际大小与声明不一致`);
  }
  return bytes;
}

function normalizedMime(value: string): string {
  return value.trim().toLowerCase();
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(normalizedMime(mime));
}

export function supportsVisionModel(model: string): boolean {
  const id = model.toLowerCase();
  const visionMarkers = [
    "minimax-m3",
    "m3",
    "vision",
    "ocr",
    "vl",
    "omni",
    "qwen3.7-plus",
    "kimi-k2.7-code",
    "glm-4v",
    "gpt-4o",
    "gemini",
    "qwen-vl",
    "claude-3",
  ];
  return visionMarkers.some((marker) => id.includes(marker));
}

export function resolveChatModel(
  requestedModel: string,
  hasImage: boolean,
  visionFallback = process.env.CHAT_MULTIMODAL_MODEL?.trim() || DEFAULT_VISION_MODEL,
) {
  if (!hasImage || supportsVisionModel(requestedModel)) {
    return { model: requestedModel, requestedModel, fallbackReason: null };
  }
  return {
    model: visionFallback,
    requestedModel,
    fallbackReason: "image_requires_multimodal" as const,
  };
}

export async function prepareChatAttachments(
  attachments: readonly ChatAttachmentPayload[] = [],
): Promise<PreparedChatAttachments> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const labels: string[] = [];
  const searchable: string[] = [];
  let byteCount = 0;
  let extractedChars = 0;
  let imageCount = 0;

  for (const attachment of attachments) {
    const bytes = decodeAttachment(attachment);
    byteCount += bytes.length;
    if (byteCount > MAX_REQUEST_BYTES) {
      throw new Error("附件总大小超过 20MB 限制");
    }

    const mime = normalizedMime(attachment.mime);
    const image = attachment.kind === "image" || isImageMime(mime);
    labels.push(`- ${attachment.name}（${image ? "图片" : "文件"}，${Math.ceil(bytes.length / 1024)}KB）`);

    if (image) {
      if (!IMAGE_MIMES.has(mime)) {
        throw new Error(`不支持的图片类型：${attachment.mime}`);
      }
      imageCount += 1;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: attachment.dataBase64,
        },
      });
      searchable.push(`[图片附件：${attachment.name}]`);
      continue;
    }

    const parsed = await parseDocument(bytes, mime, attachment.name);
    const remaining = MAX_TEXT_PER_REQUEST - extractedChars;
    const content = truncateWithin(parsed, Math.min(MAX_TEXT_PER_FILE, remaining));
    extractedChars += content.length;
    const textBlock = `附件文件：${attachment.name}\n\n${content}`;
    blocks.push({ type: "text", text: textBlock });
    searchable.push(textBlock);
  }

  return {
    blocks,
    storedLabel: labels.length === 0 ? "" : `\n\n[附件]\n${labels.join("\n")}`,
    searchableText: searchable.join("\n\n"),
    hasImage: imageCount > 0,
    imageCount,
  };
}

export function buildCurrentUserContent(
  message: string,
  prepared: PreparedChatAttachments,
): Anthropic.MessageParam["content"] {
  if (prepared.blocks.length === 0) return message;
  return [{ type: "text", text: message.trim() || "请根据附件内容回答。" }, ...prepared.blocks];
}
