import type { ChatAttachmentPayload } from "./api";

export interface ChatAttachment extends ChatAttachmentPayload {
  id: string;
  previewUrl?: string;
}

export const CHAT_ATTACHMENT_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
  ".csv",
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
].join(",");

const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取附件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(file);
  });
}

export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 10MB 限制`);
  const isImage = file.type.startsWith("image/");
  return {
    id: `${Date.now()}:${file.name}:${Math.random().toString(36).slice(2)}`,
    name: file.name || (isImage ? "粘贴图片" : "附件"),
    mime: file.type || "application/octet-stream",
    sizeBytes: file.size,
    kind: isImage ? "image" : "file",
    dataBase64: await toBase64(file),
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  };
}

export async function filesToChatAttachments(files: File[], currentCount: number): Promise<ChatAttachment[]> {
  const remaining = MAX_ATTACHMENT_COUNT - currentCount;
  if (remaining <= 0) throw new Error(`最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`);
  return Promise.all(files.slice(0, remaining).map(fileToChatAttachment));
}

export function attachmentLabels(attachments: ChatAttachmentPayload[]): string {
  if (attachments.length === 0) return "";
  return `\n\n[附件]\n${attachments.map((item) => `- ${item.name}`).join("\n")}`;
}

export function stripAttachmentForApi(attachment: ChatAttachment): ChatAttachmentPayload {
  const { previewUrl: _previewUrl, id: _id, ...payload } = attachment;
  return payload;
}
