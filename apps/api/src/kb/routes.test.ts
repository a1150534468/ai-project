import multipart from "@fastify/multipart";
import Fastify, { type InjectOptions } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UploadAdapter = {
  isMultipart: () => boolean;
  file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined>;
  body: Record<string, unknown>;
};

const mocks = vi.hoisted(() => {
  const prisma = { document: { findMany: vi.fn(), findFirst: vi.fn() } };
  return {
    prisma,
    list: vi.fn(async (_db: unknown, _userId: string): Promise<unknown[]> => []),
    create: vi.fn(async (_db: unknown, args: Record<string, unknown>) => ({ id: "kb-new", ...args })),
    rename: vi.fn(async (_db: unknown, id: string, _userId: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
    remove: vi.fn(async () => undefined),
    assertOwner: vi.fn(async () => ({ id: "kb", ownerType: "USER" })),
    assertReadable: vi.fn(async () => ({ id: "kb", ownerType: "USER" })),
    removeDocument: vi.fn(
      async (): Promise<{ sourceType: string; sourceUri: string | null } | null> => ({
        sourceType: "TEXT",
        sourceUri: "kb/kb/doc/source.txt",
      }),
    ),
    store: vi.fn(async (_db: unknown, _s3: unknown, _kbId: string, _userId: string, _request: UploadAdapter) => ({
      docId: "doc-new",
    })),
    makeS3: vi.fn(() => ({ name: "test-s3" })),
    deleteObject: vi.fn(async () => undefined),
    buildIndexDeps: vi.fn(async () => ({ name: "index-deps" })),
    indexOnce: vi.fn(async () => undefined),
  };
});

vi.mock("@ai-assistant/db", () => ({ getPrisma: () => mocks.prisma }));
vi.mock("./service.js", () => ({
  listKbsForUser: mocks.list,
  createKb: mocks.create,
  renameKb: mocks.rename,
  deleteKb: mocks.remove,
  assertKbOwner: mocks.assertOwner,
  assertKbReadable: mocks.assertReadable,
  deleteKbDocument: mocks.removeDocument,
}));
vi.mock("../storage/s3.js", () => ({ makeS3: mocks.makeS3, deleteObject: mocks.deleteObject }));
vi.mock("./deps.js", () => ({ buildIndexDeps: mocks.buildIndexDeps }));
vi.mock("./indexer.js", () => ({ indexOnce: mocks.indexOnce }));
vi.mock("./ingest.js", () => {
  class IngestError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "IngestError";
    }
  }
  return { IngestError, storeAndCreateDocument: mocks.store };
});

import { IngestError } from "./ingest.js";
import { kbRoutes } from "./routes.js";

const authHeader = { "x-test-user": "user-1" };
const forbidden = (message = "forbidden") => Object.assign(new Error(message), { name: "ForbiddenError" });

async function makeApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const userId = req.headers["x-test-user"];
    if (typeof userId === "string") req.userId = userId;
  });
  await app.register(multipart);
  await app.register(kbRoutes);
  await app.ready();
  return app;
}

async function inject(options: InjectOptions) {
  const app = await makeApp();
  const response = await app.inject(options);
  await app.close();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.document.findMany.mockResolvedValue([]);
  mocks.prisma.document.findFirst.mockResolvedValue(null);
  mocks.list.mockResolvedValue([]);
  mocks.create.mockImplementation(async (_db, args) => ({ id: "kb-new", ...args }));
  mocks.rename.mockImplementation(async (_db, id, _userId, patch) => ({ id, ...patch }));
  mocks.remove.mockResolvedValue(undefined);
  mocks.assertOwner.mockResolvedValue({ id: "kb", ownerType: "USER" });
  mocks.assertReadable.mockResolvedValue({ id: "kb", ownerType: "USER" });
  mocks.removeDocument.mockResolvedValue({ sourceType: "TEXT", sourceUri: "kb/kb/doc/source.txt" });
  mocks.store.mockResolvedValue({ docId: "doc-new" });
  mocks.makeS3.mockReturnValue({ name: "test-s3" });
  mocks.deleteObject.mockResolvedValue(undefined);
  mocks.buildIndexDeps.mockResolvedValue({ name: "index-deps" });
  mocks.indexOnce.mockResolvedValue(undefined);
});

describe("KB 路由鉴权", () => {
  it.each([
    ["GET", "/api/kb", undefined],
    ["POST", "/api/kb", { name: "kb" }],
    ["PATCH", "/api/kb/kb", { name: "kb" }],
    ["DELETE", "/api/kb/kb", undefined],
    ["GET", "/api/kb/kb/documents", undefined],
    ["GET", "/api/kb/kb/documents/doc", undefined],
    ["DELETE", "/api/kb/kb/documents/doc", undefined],
    ["POST", "/api/kb/kb/documents", { text: "hello" }],
  ])("%s %s 未登录返回 401", async (method, url, payload) => {
    const response = await inject({ method: method as InjectOptions["method"], url, payload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "未登录" });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.assertOwner).not.toHaveBeenCalled();
  });
});

describe("知识库 CRUD", () => {
  it("GET 原样返回 service 的用户可见列表", async () => {
    mocks.list.mockResolvedValueOnce([{ id: "mine" }, { id: "official" }]);
    const response = await inject({ method: "GET", url: "/api/kb", headers: authHeader });
    expect(response.json()).toEqual([{ id: "mine" }, { id: "official" }]);
    expect(mocks.list).toHaveBeenCalledWith(mocks.prisma, "user-1");
    expect(mocks.makeS3).not.toHaveBeenCalled();
  });

  it("POST 用 Zod 拒绝空名和过长描述", async () => {
    for (const payload of [{ name: "" }, { name: "ok", description: "x".repeat(1001) }]) {
      const response = await inject({ method: "POST", url: "/api/kb", headers: authHeader, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "参数不合法" });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("POST 只用认证 userId 创建 USER 库", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/kb",
      headers: authHeader,
      payload: { name: "我的库", description: "说明", userId: "attacker" },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(mocks.prisma, {
      userId: "user-1",
      name: "我的库",
      description: "说明",
    });
  });

  it("PATCH 参数错误为 400，ForbiddenError 为 403", async () => {
    const invalid = await inject({
      method: "PATCH",
      url: "/api/kb/kb-1",
      headers: authHeader,
      payload: { name: "" },
    });
    expect(invalid.statusCode).toBe(400);
    mocks.rename.mockRejectedValueOnce(forbidden("不是属主"));
    const denied = await inject({
      method: "PATCH",
      url: "/api/kb/kb-1",
      headers: authHeader,
      payload: { name: "new" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "不是属主" });
  });

  it("PATCH 把可选 patch 和认证 userId 交给 service", async () => {
    const response = await inject({
      method: "PATCH",
      url: "/api/kb/kb-1",
      headers: authHeader,
      payload: { description: "new" },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith(mocks.prisma, "kb-1", "user-1", { description: "new" });
  });

  it("DELETE 映射 403；成功时延迟创建 S3 并返回 204", async () => {
    mocks.remove.mockRejectedValueOnce(forbidden("不可删除"));
    const denied = await inject({ method: "DELETE", url: "/api/kb/kb-1", headers: authHeader });
    expect(denied.statusCode).toBe(403);
    mocks.remove.mockResolvedValueOnce(undefined);
    const removed = await inject({ method: "DELETE", url: "/api/kb/kb-1", headers: authHeader });
    expect(removed.statusCode).toBe(204);
    expect(mocks.remove).toHaveBeenLastCalledWith(mocks.prisma, { name: "test-s3" }, "kb-1", "user-1");
    expect(mocks.makeS3).toHaveBeenCalledTimes(2);
  });
});

describe("文档读取", () => {
  it("不可读库返回 403 且不查询 Document", async () => {
    mocks.assertReadable.mockRejectedValueOnce(forbidden("不可读"));
    const response = await inject({ method: "GET", url: "/api/kb/kb/documents", headers: authHeader });
    expect(response.statusCode).toBe(403);
    expect(mocks.prisma.document.findMany).not.toHaveBeenCalled();
  });

  it.each(["/api/kb/official/documents", "/api/kb/official/documents/doc"])("官方库不开放明细：%s", async (url) => {
    mocks.assertReadable.mockResolvedValueOnce({ id: "official", ownerType: "OFFICIAL" });
    const response = await inject({ method: "GET", url, headers: authHeader });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "官方知识库不开放文档明细" });
  });

  it("列表按创建时间倒序且只选择公开字段", async () => {
    mocks.prisma.document.findMany.mockResolvedValueOnce([{ id: "doc", name: "a.txt" }]);
    const response = await inject({ method: "GET", url: "/api/kb/kb/documents", headers: authHeader });
    expect(response.statusCode).toBe(200);
    const query = mocks.prisma.document.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ where: { kbId: "kb" }, orderBy: { createdAt: "desc" } });
    expect(Object.keys(query.select)).toEqual([
      "id",
      "name",
      "status",
      "sizeBytes",
      "chunkCount",
      "error",
      "sourceType",
      "sourceUri",
      "mime",
      "createdAt",
    ]);
    expect(query.select).not.toHaveProperty("tokensUsed");
    expect(query.select).not.toHaveProperty("lockedBy");
  });

  it("详情把 docId 和 kbId 一起查询，不存在返回 404", async () => {
    const response = await inject({ method: "GET", url: "/api/kb/kb/documents/missing", headers: authHeader });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "文档不存在" });
    expect(mocks.prisma.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "missing", kbId: "kb" },
      }),
    );
  });

  it("详情与列表共用公开字段投影", async () => {
    mocks.prisma.document.findFirst.mockResolvedValueOnce({ id: "doc", name: "a.txt", status: "indexed" });
    const response = await inject({ method: "GET", url: "/api/kb/kb/documents/doc", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "doc", name: "a.txt", status: "indexed" });
    const detailSelect = mocks.prisma.document.findFirst.mock.calls[0][0].select;
    await inject({ method: "GET", url: "/api/kb/kb/documents", headers: authHeader });
    expect(detailSelect).toEqual(mocks.prisma.document.findMany.mock.calls[0][0].select);
  });
});

describe("文档删除", () => {
  it("属主错误映射 403，文档不存在映射 404，均不碰 S3", async () => {
    mocks.removeDocument.mockRejectedValueOnce(forbidden("不是属主"));
    const denied = await inject({ method: "DELETE", url: "/api/kb/kb/documents/doc", headers: authHeader });
    expect(denied.statusCode).toBe(403);
    mocks.removeDocument.mockResolvedValueOnce(null);
    const missing = await inject({ method: "DELETE", url: "/api/kb/kb/documents/doc", headers: authHeader });
    expect(missing.statusCode).toBe(404);
    expect(mocks.makeS3).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it("FILE/TEXT 先删数据库再清对象；S3 失败仍返回 204", async () => {
    const order: string[] = [];
    mocks.removeDocument.mockImplementationOnce(async () => {
      order.push("database");
      return { sourceType: "FILE", sourceUri: "kb/kb/doc/file.pdf" };
    });
    mocks.deleteObject.mockImplementationOnce(async () => {
      order.push("s3");
      throw new Error("S3 unavailable");
    });
    const response = await inject({ method: "DELETE", url: "/api/kb/kb/documents/doc", headers: authHeader });
    expect(response.statusCode).toBe(204);
    expect(order).toEqual(["database", "s3"]);
    expect(mocks.deleteObject).toHaveBeenCalledWith({ name: "test-s3" }, "kb/kb/doc/file.pdf");
  });

  it("URL 文档没有自有对象，不初始化 S3", async () => {
    mocks.removeDocument.mockResolvedValueOnce({ sourceType: "URL", sourceUri: "https://example.test/doc" });
    const response = await inject({ method: "DELETE", url: "/api/kb/kb/documents/doc", headers: authHeader });
    expect(response.statusCode).toBe(204);
    expect(mocks.makeS3).not.toHaveBeenCalled();
  });
});

describe("文档入库", () => {
  it("非属主返回 403，不初始化 S3 或调用 ingest", async () => {
    mocks.assertOwner.mockRejectedValueOnce(forbidden("不是属主"));
    const response = await inject({
      method: "POST",
      url: "/api/kb/kb/documents",
      headers: authHeader,
      payload: { text: "hello" },
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.makeS3).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("IngestError 保留自身状态码和中文消息", async () => {
    mocks.store.mockRejectedValueOnce(new IngestError("文本过长", 413));
    const response = await inject({
      method: "POST",
      url: "/api/kb/kb/documents",
      headers: authHeader,
      payload: { text: "hello" },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "文本过长" });
  });

  it.each([
    ["TEXT", { text: "hello", name: "note.txt" }],
    ["URL", { url: "https://example.test/doc" }],
  ])("%s 请求适配后入库并后台索引", async (_kind, payload) => {
    const response = await inject({ method: "POST", url: "/api/kb/kb/documents", headers: authHeader, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "doc-new", status: "pending" });
    const adapter = mocks.store.mock.calls[0][4];
    expect(adapter.isMultipart()).toBe(false);
    expect(adapter.body).toEqual(payload);
    await vi.waitFor(() => expect(mocks.indexOnce).toHaveBeenCalledWith({ name: "index-deps" }, "doc-new"));
  });

  it("FILE 请求把 multipart 文件适配给 ingest", async () => {
    mocks.store.mockImplementationOnce(async (_db, _s3, _kbId, _userId, adapter) => {
      expect(adapter.isMultipart()).toBe(true);
      const file = await adapter.file();
      expect(file).toMatchObject({ filename: "note.txt", mimetype: "text/plain" });
      expect((await file!.toBuffer()).toString()).toBe("hello file");
      return { docId: "file-doc" };
    });
    const boundary = "----kb-route-test";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: text/plain",
      "",
      "hello file",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const response = await inject({
      method: "POST",
      url: "/api/kb/kb/documents",
      headers: { ...authHeader, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "file-doc", status: "pending" });
    await vi.waitFor(() => expect(mocks.indexOnce).toHaveBeenCalledWith({ name: "index-deps" }, "file-doc"));
  });

  it("后台索引装配失败不改变已完成的入库响应", async () => {
    mocks.buildIndexDeps.mockRejectedValueOnce(new Error("embedding unavailable"));
    const response = await inject({
      method: "POST",
      url: "/api/kb/kb/documents",
      headers: authHeader,
      payload: { text: "hello" },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(mocks.buildIndexDeps).toHaveBeenCalledOnce());
    expect(mocks.indexOnce).not.toHaveBeenCalled();
  });
});
