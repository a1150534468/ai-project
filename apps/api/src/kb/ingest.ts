import type { PrismaClient, Document } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { S3 } from "../storage/s3.js";
import { putObject, deleteObject } from "../storage/s3.js";
import { assertSafeUrl, SsrfError } from "./url-fetch.js";
import { assertQuota, type KbQuotaBilling } from "./service.js";
import { loadEmbeddingConfig } from "../memory/embedding-client.js";

export const KB_MAX_FILE_BYTES = parseInt(process.env.KB_MAX_FILE_BYTES ?? "20971520", 10); // 20MB
export const KB_MAX_TEXT_CHARS = parseInt(process.env.KB_MAX_TEXT_CHARS ?? "200000", 10);
export const KB_BYTES_PER_TOKEN = parseInt(process.env.KB_BYTES_PER_TOKEN ?? "3", 10);

// 允许的文件后缀
export const ALLOWED_FILE_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
]);

// MIME 类型白名单
export const ALLOWED_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "text/csv",
  "text/x-log",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const ALLOWED_FILE_TYPES_TEXT = "txt, md, json, xml, yaml, csv, log, pdf, docx, xlsx, xls, pptx";

export function sanitizeFilename(filename: string): string {
  // 移除路径组件和危险字符
  const basename = filename.split(/[\/\\]/).pop() ?? "";
  const safeName = basename
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return safeName && safeName !== "." && safeName !== ".." ? safeName : "document";
}

export function getFileExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

export function validateFileUpload(
  filename: string,
  mime: string,
  sizeBytes: number
): { ok: true } | { ok: false; error: string } {
  const ext = getFileExt(filename);

  // 校验后缀
  if (!ALLOWED_FILE_EXTS.has(ext)) {
    return {
      ok: false,
      error: `不支持的文件类型：${ext}，仅支持 ${ALLOWED_FILE_TYPES_TEXT}`,
    };
  }

  // 校验大小
  if (sizeBytes > KB_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `文件过大，最多 ${KB_MAX_FILE_BYTES / 1024 / 1024}MB`,
    };
  }

  // MIME 校验（可选放行未知但后缀合法的 MIME）
  if (mime && !ALLOWED_MIMES.has(mime)) {
    // 根据后缀推断 mime，不强制外部提供的 mime 必须在白名单中
    // 仅在完全不匹配时警告
  }

  return { ok: true };
}

/**
 * 文档摄取结果
 */
export interface IngestResult {
  doc: Document;
  docId: string;
  sourceUri: string | null;
  sizeBytes: number;
}

/**
 * 摄取错误
 */
export class IngestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/**
 * 共享的文档摄取逻辑（支持 FILE/TEXT/URL）
 * 适用于 USER 库（计费）和 OFFICIAL 库（跳计费）
 *
 * @param skipQuotaCheck - true 时跳过 assertQuota 与 billing.reserve（OFFICIAL 库）；false 时执行计费路径（USER 库）
 * @returns IngestResult 包含 Document 和相关元数据
 * @throws IngestError 包含 statusCode 供路由使用
 */
export async function storeAndCreateDocument(
  prisma: PrismaClient,
  s3: S3,
  kbId: string,
  userId: string | null,
  req: {
    isMultipart: () => boolean;
    file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined>;
    body?: Record<string, unknown>;
  },
  options: {
    skipQuotaCheck?: boolean;
    billing?: { reserve: (args: any) => Promise<any> } | null;
    quotaBilling?: KbQuotaBilling;
  } = {},
): Promise<IngestResult> {
  const skipQuotaCheck = options.skipQuotaCheck ?? false;
  const billing = options.billing;
  const quotaBilling = options.quotaBilling;

  const isMultipart = req.isMultipart();
  const bodyObj = (req.body as Record<string, unknown>) || {};
  const hasText = typeof bodyObj.text === "string";
  const hasUrl = typeof bodyObj.url === "string";

  let sourceType: "TEXT" | "URL" | "FILE" = "TEXT";
  let sourceUri: string | null = null;
  let sizeBytes = 0;
  let buf: Buffer | null = null;
  let mime = "text/plain";
  let filename = "document";

  try {
    if (isMultipart) {
      // FILE 上传
      const data = await req.file();
      if (!data) {
        throw new IngestError("未提供文件", 400);
      }

      try {
        buf = await data.toBuffer();
      } catch {
        // multipart 超过 limits.fileSize 会抛异常
        throw new IngestError(`文件过大，最多 ${KB_MAX_FILE_BYTES / 1024 / 1024}MB`, 413);
      }

      sourceType = "FILE";
      sizeBytes = buf.length;
      filename = sanitizeFilename(data.filename);
      mime = data.mimetype || "application/octet-stream";

      // 校验文件
      const validation = validateFileUpload(data.filename, mime, sizeBytes);
      if (!validation.ok) {
        throw new IngestError(validation.error, 400);
      }
    } else if (hasText) {
      const text = bodyObj.text as string;
      if (text.length > KB_MAX_TEXT_CHARS) {
        throw new IngestError(`文本过长，最多 ${KB_MAX_TEXT_CHARS} 字符`, 400);
      }
      sourceType = "TEXT";
      buf = Buffer.from(text);
      sizeBytes = Buffer.byteLength(text);
      filename = (bodyObj.name as string) ?? "document.txt";
      mime = "text/plain";
    } else if (hasUrl) {
      const url = bodyObj.url as string;
      sourceType = "URL";
      sourceUri = url;
      sizeBytes = 0; // URL 先不知道大小，估值用保守值
      filename = (bodyObj.name as string) ?? new URL(url).pathname.split("/").pop() ?? "document";

      // URL 安全校验（SSRF）
      try {
        await assertSafeUrl(url);
      } catch (err) {
        if (err instanceof SsrfError) {
          throw new IngestError(`SSRF 防护：${err.message}`, 400);
        }
        throw err;
      }
    } else {
      throw new IngestError("必须提供文件、text 或 url", 400);
    }

    // 1. 配额校验（仅在非跳过时）
    if (!skipQuotaCheck && quotaBilling && userId) {
      try {
        await assertQuota(prisma, quotaBilling, userId, sizeBytes);
      } catch (err) {
        if (err instanceof Error && err.name === "QuotaExceededError") {
          throw new IngestError("存储空间不足", 402);
        }
        throw err;
      }
    }

    // 2. 落存储（TEXT/FILE 到 S3，URL 只记录 URL）
    const docId = randomUUID();
    if ((sourceType === "TEXT" || sourceType === "FILE") && buf) {
      const s3Key = `kb/${kbId}/${docId}/${filename}`;
      await putObject(s3, s3Key, buf, mime);
      sourceUri = s3Key;
    }

    // 3. 建 Document
    const doc = await prisma.document.create({
      data: {
        id: docId,
        kbId,
        name: filename,
        sourceType,
        sourceUri: sourceUri || undefined,
        mime: sourceType !== "URL" ? mime : undefined,
        sizeBytes: sourceType !== "URL" ? sizeBytes : undefined,
        status: "pending",
        opId: `kb:doc:${docId}`,
      },
    });

    // 4. 预扣（仅在非跳过时，且为用户库）
    if (!skipQuotaCheck && billing && userId) {
      const estTokens = Math.max(1, Math.ceil(sizeBytes / KB_BYTES_PER_TOKEN) || 1);
      try {
        await billing.reserve({
          operationId: doc.opId || `kb:doc:${docId}`,
          userId,
          type: "kb_index",
          model: loadEmbeddingConfig().model,
          inputTokens: estTokens,
          maxOutputTokens: 0,
        });
      } catch (err) {
        // 任何 reserve 失败都回滚已建 Document + 已落 S3 对象
        await prisma.document.delete({ where: { id: docId } }).catch(() => {});
        if (sourceUri && (sourceType === "TEXT" || sourceType === "FILE")) {
          await deleteObject(s3, sourceUri).catch(() => {});
        }

        if (err instanceof Error && err.name === "InsufficientBalanceError") {
          throw new IngestError("积分不足，请充值", 402);
        }

        // 其他异常（billing 不可达/5xx）→ 502
        throw new IngestError("计费服务不可用", 502);
      }
    }

    return {
      doc,
      docId,
      sourceUri,
      sizeBytes,
    };
  } catch (err) {
    if (err instanceof IngestError) {
      throw err;
    }
    // 未知错误向上抛
    throw err;
  }
}
