/**
 * 对话框附件的纯逻辑层：挑文件 → 读成 base64 → 发给后端前把只在前端用的字段摘掉。
 * 组件那侧（`components/chat/useChatComposerState.ts`）只管 state，规则与文案都在这里。
 */
import type { ChatAttachmentPayload } from "./api";

/**
 * 前端在后端认的载荷上多挂两样：`id` 给 React 当 key、也给「删掉这一个」定位；
 * `previewUrl` 是图片的本地 blob URL（`stripAttachmentForApi` 会把这两样摘掉再发）。
 */
export interface ChatAttachment extends ChatAttachmentPayload {
  id: string;
  previewUrl?: string;
}

/** 图片按 MIME 收：截图、拍照、粘贴进来的 File 常常有 type 而没有像样的文件名。 */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** 文档按扩展名收：Office 那几个的 MIME 各系统写法不一，扩展名反而是准的。 */
const DOCUMENT_EXTENSIONS = [
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
];

/** `<input accept>` 的值。MIME 与扩展名混着写正是这个属性的用法，不用统一成一种。 */
export const CHAT_ATTACHMENT_ACCEPT = [...IMAGE_MIME_TYPES, ...DOCUMENT_EXTENSIONS].join(",");

/** 两条上限。提示文案从常量算出来，别让「改了数字忘改文案」这种事发生。 */
const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_MB = 10;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/**
 * `readAsDataURL` 给的是 `data:<mime>;base64,<载荷>`，要的只是逗号后面那截。
 * 按第一个逗号切而不是 `split(",")[1]`：万一读到个没有前缀的怪结果，原样返回也比 undefined 好。
 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("读取附件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");

      resolve(comma < 0 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 ${MAX_ATTACHMENT_MB}MB 限制`);

  const isImage = file.type.startsWith("image/");

  return {
    // 时间戳 + 文件名 + 随机串：同一秒里连着粘两张同名图也不会撞 key
    id: `${Date.now()}:${file.name}:${Math.random().toString(36).slice(2)}`,
    name: file.name || (isImage ? "粘贴图片" : "附件"),
    mime: file.type || "application/octet-stream",
    sizeBytes: file.size,
    kind: isImage ? "image" : "file",
    dataBase64: await toBase64(file),
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  };
}

/**
 * 一次拖进来一批。超出名额的那几个直接不收（而不是整批失败）—— 拖了 20 个进来，
 * 收下前几个比一个都不收有用；名额已经用完才报错，否则用户点了没反应。
 */
export async function filesToChatAttachments(files: File[], currentCount: number): Promise<ChatAttachment[]> {
  const remaining = MAX_ATTACHMENT_COUNT - currentCount;
  if (remaining <= 0) throw new Error(`最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`);

  return Promise.all(files.slice(0, remaining).map(fileToChatAttachment));
}

/** 附件清单追加到消息正文末尾：模型只看得到文本，附件名得写进去它才知道有这些东西。 */
export function attachmentLabels(attachments: ChatAttachmentPayload[]): string {
  if (attachments.length === 0) return "";

  return `\n\n[附件]\n${attachments.map((item) => `- ${item.name}`).join("\n")}`;
}

/** 摘掉两个本地字段，其余原样发 —— 用 rest 而不是逐个挑：载荷以后加字段这里不用改。 */
export function stripAttachmentForApi(attachment: ChatAttachment): ChatAttachmentPayload {
  const { id: _id, previewUrl: _previewUrl, ...payload } = attachment;

  return payload;
}
