import type { PrismaClient, Document } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { S3 } from "../storage/s3.js";
import { putObject } from "../storage/s3.js";
import { assertSafeUrl, SsrfError } from "./url-fetch.js";

export const KB_MAX_FILE_BYTES = parseInt(process.env.KB_MAX_FILE_BYTES ?? "20971520", 10); // 20MB
export const KB_MAX_TEXT_CHARS = parseInt(process.env.KB_MAX_TEXT_CHARS ?? "200000", 10);

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
 * USER 库与 OFFICIAL 库共用同一条路径
 *
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
): Promise<IngestResult> {
  const isMultipart = req.isMultipart();
  const bodyObj = (req.body as Record<string, unknown>) || {};
  const hasText = typeof bodyObj.text === "string";
  const hasUrl = typeof bodyObj.url === "string";

  // 这个联合类型就是 sourceType 的全部校验：它不是客户端入参（由下面三个分支推导得出），
  // 库里也没有 CHECK 约束。ARTIFACT 随 P1.2/P5.2 退役后，这三种取值即穷尽。
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

    // 1. 落存储（TEXT/FILE 到 S3，URL 只记录 URL）
    const docId = randomUUID();
    if ((sourceType === "TEXT" || sourceType === "FILE") && buf) {
      const s3Key = `kb/${kbId}/${docId}/${filename}`;
      await putObject(s3, s3Key, buf, mime);
      sourceUri = s3Key;
    }

    // 2. 建 Document
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
      },
    });

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
