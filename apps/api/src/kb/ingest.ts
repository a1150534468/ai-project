import { randomUUID } from "node:crypto";
import type { Document, PrismaClient } from "@prisma/client";
import { deleteObject, putObject, type S3 } from "../storage/s3.js";
import { assertSafeUrl, SsrfError } from "./url-fetch.js";

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 200_000;

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const KB_MAX_FILE_BYTES = positiveInteger(process.env.KB_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
export const KB_MAX_TEXT_CHARS = positiveInteger(process.env.KB_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);

const MIME_BY_EXTENSION = new Map<string, ReadonlySet<string>>([
  [".txt", new Set(["text/plain"])],
  [".md", new Set(["text/markdown", "text/plain"])],
  [".markdown", new Set(["text/markdown", "text/plain"])],
  [".json", new Set(["application/json", "text/plain"])],
  [".xml", new Set(["application/xml", "text/xml", "text/plain"])],
  [".yaml", new Set(["application/x-yaml", "application/yaml", "text/yaml", "text/x-yaml", "text/plain"])],
  [".yml", new Set(["application/x-yaml", "application/yaml", "text/yaml", "text/x-yaml", "text/plain"])],
  [".csv", new Set(["text/csv", "text/plain"])],
  [".log", new Set(["text/x-log", "text/plain"])],
  [".pdf", new Set(["application/pdf"])],
  [".docx", new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"])],
  [".xlsx", new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])],
  [".xls", new Set(["application/vnd.ms-excel"])],
  [".pptx", new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"])],
]);

export const ALLOWED_FILE_EXTS = new Set(MIME_BY_EXTENSION.keys());
export const ALLOWED_MIMES = new Set([...MIME_BY_EXTENSION.values()].flatMap((values) => [...values]));
const BLOCKED_MIMES = new Set(["application/x-msdownload", "application/x-dosexec", "application/x-executable"]);
const ALLOWED_FILE_TYPES_TEXT = "txt, md, json, xml, yaml, csv, log, pdf, docx, xlsx, xls, pptx";

function normalizedMime(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const safe = basename.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "document";
}

export function getFileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

export function validateFileUpload(
  filename: string,
  mime: string,
  sizeBytes: number,
): { ok: true } | { ok: false; error: string } {
  const extension = getFileExt(filename);
  if (!ALLOWED_FILE_EXTS.has(extension)) {
    return { ok: false, error: `不支持的文件类型：${extension}，仅支持 ${ALLOWED_FILE_TYPES_TEXT}` };
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return { ok: false, error: "文件大小不合法" };
  }
  if (sizeBytes > KB_MAX_FILE_BYTES) {
    return { ok: false, error: `文件过大，最多 ${KB_MAX_FILE_BYTES / 1024 / 1024}MB` };
  }

  const contentType = normalizedMime(mime);
  if (BLOCKED_MIMES.has(contentType)
    || (ALLOWED_MIMES.has(contentType) && !MIME_BY_EXTENSION.get(extension)?.has(contentType))) {
    return { ok: false, error: `文件类型与扩展名不匹配：${contentType}` };
  }
  return { ok: true };
}

export interface IngestResult {
  doc: Document;
  docId: string;
  sourceUri: string | null;
  sizeBytes: number;
}

export class IngestError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "IngestError";
  }
}

type IngestSource =
  | { type: "FILE" | "TEXT"; filename: string; mime: string; bytes: Buffer }
  | { type: "URL"; filename: string; url: string };

type UploadRequest = {
  isMultipart: () => boolean;
  file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined>;
  body?: Record<string, unknown>;
};

function requestedName(body: Record<string, unknown>, fallback: string): string {
  return sanitizeFilename(typeof body.name === "string" ? body.name : fallback);
}

async function readSource(req: UploadRequest): Promise<IngestSource> {
  const body = req.body ?? {};
  if (req.isMultipart()) {
    const file = await req.file();
    if (!file) throw new IngestError("未提供文件", 400);
    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch {
      throw new IngestError(`文件过大，最多 ${KB_MAX_FILE_BYTES / 1024 / 1024}MB`, 413);
    }
    const filename = sanitizeFilename(file.filename);
    const mime = normalizedMime(file.mimetype || "application/octet-stream");
    const validation = validateFileUpload(filename, mime, bytes.length);
    if (!validation.ok) throw new IngestError(validation.error, 400);
    return { type: "FILE", filename, mime: mime || "application/octet-stream", bytes };
  }

  if (typeof body.text === "string") {
    if (body.text.length > KB_MAX_TEXT_CHARS) {
      throw new IngestError(`文本过长，最多 ${KB_MAX_TEXT_CHARS} 字符`, 400);
    }
    return {
      type: "TEXT",
      filename: requestedName(body, "document.txt"),
      mime: "text/plain",
      bytes: Buffer.from(body.text),
    };
  }

  if (typeof body.url === "string") {
    try {
      await assertSafeUrl(body.url);
      const parsed = new URL(body.url);
      return {
        type: "URL",
        url: body.url,
        filename: requestedName(body, parsed.pathname.split("/").pop() || "document"),
      };
    } catch (error) {
      const reason = error instanceof SsrfError ? error.message : error instanceof Error ? error.message : String(error);
      throw new IngestError(`SSRF 防护：${reason}`, 400);
    }
  }

  throw new IngestError("必须提供文件、text 或 url", 400);
}

/** FILE/TEXT 先落对象再建 Document；建库失败时只补偿本次刚写的对象。 */
export async function storeAndCreateDocument(
  prisma: PrismaClient,
  s3: S3,
  kbId: string,
  _userId: string | null,
  req: UploadRequest,
): Promise<IngestResult> {
  const source = await readSource(req);
  const docId = randomUUID();
  let sourceUri: string | null = source.type === "URL" ? source.url : null;
  let uploadedKey: string | null = null;
  const sizeBytes = source.type === "URL" ? 0 : source.bytes.length;

  try {
    if (source.type !== "URL") {
      const key = `kb/${kbId}/${docId}/${source.filename}`;
      await putObject(s3, key, source.bytes, source.mime);
      uploadedKey = key;
      sourceUri = key;
    }

    const doc = await prisma.document.create({
      data: {
        id: docId,
        kbId,
        name: source.filename,
        sourceType: source.type,
        sourceUri: sourceUri ?? undefined,
        mime: source.type === "URL" ? undefined : source.mime,
        sizeBytes: source.type === "URL" ? undefined : sizeBytes,
        status: "pending",
      },
    });
    return { doc, docId, sourceUri, sizeBytes };
  } catch (error) {
    if (uploadedKey) await deleteObject(s3, uploadedKey).catch(() => undefined);
    throw error;
  }
}
