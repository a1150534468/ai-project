import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn() }));
const urlGuard = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock("../storage/s3.js", () => ({
  putObject: storage.put,
  deleteObject: storage.remove,
}));
vi.mock("./url-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./url-fetch.js")>();
  return { ...actual, assertSafeUrl: urlGuard.check };
});

import {
  ALLOWED_FILE_EXTS,
  IngestError,
  KB_MAX_FILE_BYTES,
  KB_MAX_TEXT_CHARS,
  getFileExt,
  sanitizeFilename,
  storeAndCreateDocument,
  validateFileUpload,
} from "./ingest.js";
import { SsrfError } from "./url-fetch.js";

function prisma(create = vi.fn(async ({ data }) => ({ ...data, createdAt: new Date(), updatedAt: new Date() }))) {
  return { client: { document: { create } } as never, create };
}

function request(body: Record<string, unknown>) {
  return { isMultipart: () => false, file: vi.fn(), body };
}

function multipart(file?: { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }) {
  return { isMultipart: () => true, file: vi.fn(async () => file), body: {} };
}

beforeEach(() => {
  storage.put.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
  urlGuard.check.mockReset().mockResolvedValue(["93.184.216.34"]);
});

afterEach(() => vi.unstubAllEnvs());

describe("ingest 文件名与上传校验", () => {
  it("只保留 basename，做 NFC、控制字符和空白清理", () => {
    expect(sanitizeFilename("../../中文文档\u0000?.docx")).toBe("中文文档__.docx");
    expect(sanitizeFilename("目录\\A   B.txt")).toBe("A B.txt");
    expect(sanitizeFilename(".." as string)).toBe("document");
  });

  it("扩展名大小写不敏感，未知或 MIME 冲突明确拒绝", () => {
    expect(getFileExt("A.PDF")).toBe(".pdf");
    expect(ALLOWED_FILE_EXTS.has(".pptx")).toBe(true);
    expect(validateFileUpload("a.PDF", "application/pdf; charset=binary", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.pdf", "application/octet-stream", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.pdf", "application/x-pdf", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.docx", "application/zip", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.yaml", "application/yaml", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.yml", "text/x-yaml", 10)).toEqual({ ok: true });
    expect(validateFileUpload("a.pdf", "application/x-msdownload", 10)).toEqual({
      ok: false,
      error: "文件类型与扩展名不匹配：application/x-msdownload",
    });
    expect(validateFileUpload("a.exe", "application/octet-stream", 10).ok).toBe(false);
  });

  it("文件大小等于上限可收，非法数值和超限拒绝", () => {
    expect(validateFileUpload("a.txt", "text/plain", KB_MAX_FILE_BYTES)).toEqual({ ok: true });
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, KB_MAX_FILE_BYTES + 1]) {
      expect(validateFileUpload("a.txt", "text/plain", value).ok).toBe(false);
    }
  });
});

describe("storeAndCreateDocument", () => {
  it("FILE 清洗名称、先上传再创建 pending Document", async () => {
    const db = prisma();
    const order: string[] = [];
    storage.put.mockImplementation(async () => { order.push("put"); });
    db.create.mockImplementation(async ({ data }) => { order.push("create"); return data; });
    const result = await storeAndCreateDocument(db.client, {} as never, "kb1", "u1", multipart({
      filename: "../报告.PDF",
      mimetype: "application/pdf",
      toBuffer: async () => Buffer.from("pdf"),
    }));
    expect(order).toEqual(["put", "create"]);
    expect(result.doc).toMatchObject({ name: "报告.PDF", sourceType: "FILE", status: "pending", sizeBytes: 3 });
    expect(result.sourceUri).toMatch(/^kb\/kb1\/[^/]+\/报告\.PDF$/);
  });

  it("multipart 没文件与读取超限分别返回 400/413", async () => {
    const db = prisma();
    await expect(storeAndCreateDocument(db.client, {} as never, "kb", null, multipart()))
      .rejects.toMatchObject({ message: "未提供文件", statusCode: 400 });
    await expect(storeAndCreateDocument(db.client, {} as never, "kb", null, multipart({
      filename: "a.txt", mimetype: "text/plain", toBuffer: async () => { throw new Error("limit"); },
    }))).rejects.toMatchObject({ statusCode: 413 });
  });

  it("TEXT 保持空串契约，名称去路径且按 UTF-16 长度限流", async () => {
    const db = prisma();
    const result = await storeAndCreateDocument(db.client, {} as never, "kb", "u", request({
      text: "", name: "../notes.txt",
    }));
    expect(result.doc).toMatchObject({ name: "notes.txt", sourceType: "TEXT", sizeBytes: 0 });
    expect(storage.put).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/\/notes\.txt$/), Buffer.alloc(0), "text/plain");

    await expect(storeAndCreateDocument(db.client, {} as never, "kb", "u", request({
      text: "😀".repeat(Math.floor(KB_MAX_TEXT_CHARS / 2) + 1),
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("URL 保存原值，根路径和非字符串 name 都得到 document", async () => {
    const db = prisma();
    const result = await storeAndCreateDocument(db.client, {} as never, "kb", null, request({
      url: "https://example.com/", name: 42,
    }));
    expect(result.doc).toMatchObject({ name: "document", sourceType: "URL", sourceUri: "https://example.com/" });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("畸形或危险 URL 稳定变成 IngestError 400", async () => {
    const db = prisma();
    urlGuard.check.mockRejectedValueOnce(new SsrfError("blocked"));
    await expect(storeAndCreateDocument(db.client, {} as never, "kb", null, request({ url: "http://127.0.0.1" })))
      .rejects.toBeInstanceOf(IngestError);
    urlGuard.check.mockResolvedValueOnce([]);
    await expect(storeAndCreateDocument(db.client, {} as never, "kb", null, request({ url: "not a url" })))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("Document 创建失败补删刚上传的对象，补偿失败不遮蔽原错", async () => {
    const cause = new Error("db failed");
    const db = prisma(vi.fn().mockRejectedValue(cause));
    storage.remove.mockRejectedValue(new Error("cleanup failed"));
    const pending = storeAndCreateDocument(db.client, {} as never, "kb", null, request({ text: "正文" }));
    await expect(pending).rejects.toBe(cause);
    const key = storage.put.mock.calls[0][1];
    expect(storage.remove).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledWith(expect.anything(), key);
  });

  it("没有来源时零副作用", async () => {
    const db = prisma();
    await expect(storeAndCreateDocument(db.client, {} as never, "kb", null, request({})))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(storage.put).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });
});
