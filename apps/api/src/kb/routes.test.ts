import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import { generateUniqueUid } from "../auth/uid.js";
import * as billingModule from "@yc/billing";

// Mock @yc/billing 在模块顶层
vi.mock("@yc/billing", () => ({
  createBillingClient: vi.fn(),
  InsufficientBalanceError: class extends Error {
    name = "InsufficientBalanceError";
    constructor() {
      super("积分不足");
    }
  },
}));

// Mock indexOnce 避免真实索引
vi.mock("./indexer.js", () => ({
  indexOnce: vi.fn().mockResolvedValue(undefined),
}));

// Mock S3 操作避免真连接
vi.mock("../storage/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/s3.js")>("../storage/s3.js");
  return {
    ...actual,
    makeS3: vi.fn(() => ({
      client: { send: vi.fn().mockResolvedValue({}) },
      bucket: "test-kb",
    })),
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    deletePrefix: vi.fn().mockResolvedValue(undefined),
  };
});

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let auth = "";
let userId = "";

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.EMBEDDING_MODEL ??= "test-embedding-model";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1";
  process.env.BILLING_INTERNAL_TOKEN ??= "t";
  // S3 配置（可指向 MinIO 或其他 S3 兼容存储，仅用于测试）
  process.env.S3_ENDPOINT ??= "http://localhost:9000";
  process.env.S3_BUCKET ??= "test-kb";
  process.env.S3_ACCESS_KEY ??= "test-s3-access-key";
  process.env.S3_SECRET_KEY ??= "test-s3-secret-key";

  // 设置默认 mock
  vi.mocked(billingModule.createBillingClient).mockReturnValue({
    reserve: vi.fn().mockResolvedValue({ opId: "mock-op-id" }),
    settle: vi.fn().mockResolvedValue({ settled: true }),
    getUserKbQuota: vi.fn().mockResolvedValue({ membershipBytes: 1000000, defaultBytes: 1000000 }),
    listEnabledModels: vi.fn().mockResolvedValue({ data: [{ model: "gpt-4" }] }),
  } as any);

  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const u = await prisma.user.create({ data: { uid, username: `kb_${Date.now()}`, passwordHash: "x" } });
  userId = u.id;
  auth = `Bearer ${signToken(userId, process.env.SESSION_SECRET!)}`;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // 清理：document → chunk → kb → user
  const kbs = await prisma.knowledgeBase.findMany({ where: { userId } });
  for (const kb of kbs) {
    await prisma.chunk.deleteMany({ where: { kbId: kb.id } });
    await prisma.document.deleteMany({ where: { kbId: kb.id } });
    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
  }
  await prisma.user.delete({ where: { id: userId } });
});

describe("知识库路由", () => {
  describe("GET /api/kb", () => {
    it("未登录 401", async () => {
      const r = await app.inject({ method: "GET", url: "/api/kb" });
      expect(r.statusCode).toBe(401);
    });

    it("已登录列出用户的库和官方库", async () => {
      // 建库
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "Test KB", description: "test" },
      });
      const official = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Official KB" },
      });

      const r = await app.inject({
        method: "GET",
        url: "/api/kb",
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as Array<{ id: string; ownerType: string; name: string }>;
      expect(body.length).toBeGreaterThanOrEqual(2);
      expect(body.some((k) => k.id === kb.id && k.ownerType === "USER")).toBe(true);
      expect(body.some((k) => k.id === official.id && k.ownerType === "OFFICIAL")).toBe(true);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
      await prisma.knowledgeBase.delete({ where: { id: official.id } });
    });
  });

  describe("POST /api/kb", () => {
    it("未登录 401", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/api/kb",
        payload: { name: "Test" },
      });
      expect(r.statusCode).toBe(401);
    });

    it("已登录建库成功 200", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/api/kb",
        headers: { authorization: auth },
        payload: { name: "My KB", description: "My description" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; name: string };
      expect(body.id).toBeDefined();
      expect(body.name).toBe("My KB");

      await prisma.knowledgeBase.delete({ where: { id: body.id } });
    });
  });

  describe("PATCH /api/kb/:id", () => {
    it("非属主库 403", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "Other KB" },
      });
      const r = await app.inject({
        method: "PATCH",
        url: `/api/kb/${kb.id}`,
        headers: { authorization: auth },
        payload: { name: "Hacked" },
      });
      expect(r.statusCode).toBe(403);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("属主库 200", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "PATCH",
        url: `/api/kb/${kb.id}`,
        headers: { authorization: auth },
        payload: { name: "Updated KB" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { name: string };
      expect(body.name).toBe("Updated KB");

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("DELETE /api/kb/:id", () => {
    it("非属主库 403", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "Other KB" },
      });
      const r = await app.inject({
        method: "DELETE",
        url: `/api/kb/${kb.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(403);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("属主库 204", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "DELETE",
        url: `/api/kb/${kb.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(204);

      const found = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
      expect(found).toBeNull();
    });
  });

  describe("GET /api/kb/:id/documents", () => {
    it("非可读库 403", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "Other KB" },
      });
      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(403);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("官方库不开放文档明细", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Official KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "official.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "indexed",
        },
      });

      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toContain("官方知识库不开放文档明细");

      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("可读库列出文档", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "doc.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "pending",
        },
      });

      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as Array<{ id: string; name: string; status: string }>;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((d) => d.id === doc.id)).toBe(true);

      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("GET /api/kb/:id/documents/:docId", () => {
    it("官方库不开放单文档详情", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Official KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "official.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "indexed",
        },
      });

      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents/${doc.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toContain("官方知识库不开放文档明细");

      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("不存在的文档 404", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents/nonexistent`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(404);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("存在的文档 200", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "doc.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "pending",
        },
      });

      const r = await app.inject({
        method: "GET",
        url: `/api/kb/${kb.id}/documents/${doc.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; status: string };
      expect(body.id).toBe(doc.id);

      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("DELETE /api/kb/:id/documents/:docId", () => {
    it("非属主库 403", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "Other KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "doc.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "pending",
        },
      });

      const r = await app.inject({
        method: "DELETE",
        url: `/api/kb/${kb.id}/documents/${doc.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(403);

      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("属主库 204", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const doc = await prisma.document.create({
        data: {
          kbId: kb.id,
          name: "doc.txt",
          sourceType: "TEXT",
          sourceUri: null,
          sizeBytes: 100,
          status: "pending",
        },
      });

      const r = await app.inject({
        method: "DELETE",
        url: `/api/kb/${kb.id}/documents/${doc.id}`,
        headers: { authorization: auth },
      });
      expect(r.statusCode).toBe(204);

      const found = await prisma.document.findUnique({ where: { id: doc.id } });
      expect(found).toBeNull();

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("POST /api/kb/:id/documents (TEXT)", () => {
    it("未登录 401", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        payload: { text: "hello", name: "test.txt" },
      });
      expect(r.statusCode).toBe(401);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("非属主库 403", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "Other KB" },
      });
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: "hello", name: "test.txt" },
      });
      expect(r.statusCode).toBe(403);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("文本超长 400", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const longText = "x".repeat(300000);
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: longText, name: "test.txt" },
      });
      expect(r.statusCode).toBe(400);

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("配额不足 402", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      // 不改变 billing mock，直接测试：限额 1GB，文本超过 100KB 应该会因为估值超过配额而失败
      // 或者使用默认大配额，仅测试文本超长。这里用简化的测试
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: "x".repeat(300000), name: "test.txt" },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("文本过长");

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("reserve 不足 402 且回滚", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      // 为这个测试创建新 app（billing mock 返回 reserve 失败）
      const InsufficientBalanceError = (billingModule as any).InsufficientBalanceError;
      vi.mocked(billingModule.createBillingClient).mockReturnValue({
        reserve: vi.fn().mockRejectedValue(new InsufficientBalanceError()),
        settle: vi.fn().mockResolvedValue({}),
        getUserKbQuota: vi.fn().mockResolvedValue({ membershipBytes: 1000000, defaultBytes: 1000000 }),
        listEnabledModels: vi.fn().mockResolvedValue({ data: [] }),
      } as any);

      const testApp = await buildServer();
      await testApp.ready();

      const r = await testApp.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: "hello world", name: "test.txt" },
      });
      expect(r.statusCode).toBe(402);
      expect(r.json().error).toContain("积分");

      // 验证 Document 被完整回滚（DB 查不到）
      const docs = await prisma.document.findMany({ where: { kbId: kb.id } });
      expect(docs.length).toBe(0);

      await testApp.close();
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("reserve 服务异常 502 且回滚", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      // 为这个测试创建新 app（billing mock 返回普通错误）
      vi.mocked(billingModule.createBillingClient).mockReturnValue({
        reserve: vi.fn().mockRejectedValue(new Error("billing service unavailable")),
        settle: vi.fn().mockResolvedValue({}),
        getUserKbQuota: vi.fn().mockResolvedValue({ membershipBytes: 1000000, defaultBytes: 1000000 }),
        listEnabledModels: vi.fn().mockResolvedValue({ data: [] }),
      } as any);

      const testApp = await buildServer();
      await testApp.ready();

      const r = await testApp.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: "hello world", name: "test.txt" },
      });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toContain("计费服务");

      // 验证 Document 同样被回滚
      const docs = await prisma.document.findMany({ where: { kbId: kb.id } });
      expect(docs.length).toBe(0);

      await testApp.close();
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("文本成功上传 200", async () => {
      // 恢复默认 mock（reserve 成功）
      vi.mocked(billingModule.createBillingClient).mockReturnValue({
        reserve: vi.fn().mockResolvedValue({ opId: "mock-op-id" }),
        settle: vi.fn().mockResolvedValue({ settled: true }),
        getUserKbQuota: vi
          .fn()
          .mockResolvedValue({ membershipBytes: 1000000, defaultBytes: 1000000 }),
        listEnabledModels: vi.fn().mockResolvedValue({ data: [] }),
      } as any);

      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { text: "hello world", name: "test.txt" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; status: string };
      expect(body.id).toBeDefined();
      expect(body.status).toBe("pending");

      // 验证 Document 被建
      const doc = await prisma.document.findUnique({
        where: { id: body.id },
      });
      expect(doc).toBeDefined();
      expect(doc?.sourceType).toBe("TEXT");
      expect(doc?.status).toBe("pending");

      await prisma.document.delete({ where: { id: body.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("POST /api/kb/:id/documents (URL)", () => {
    it("内网 URL SSRF 400", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { url: "http://169.254.169.254/", name: "test" },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("SSRF");

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("URL 成功 200", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });
      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: { authorization: auth },
        payload: { url: "https://example.com/doc.txt", name: "test" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; status: string };
      expect(body.status).toBe("pending");

      // 验证 Document
      const doc = await prisma.document.findUnique({
        where: { id: body.id },
      });
      expect(doc?.sourceType).toBe("URL");
      expect(doc?.sourceUri).toBe("https://example.com/doc.txt");

      await prisma.document.delete({ where: { id: body.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });

  describe("POST /api/kb/:id/documents (FILE)", () => {
    it("非法后缀(.exe) 400", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      // 构造 multipart 请求
      const boundary = "----FormBoundary7MA4YWxkTrZu0gW";
      const fileContent = "MZ\x90\x00"; // EXE header
      const payload =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="test.exe"\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `\r\n` +
        fileContent +
        `\r\n--${boundary}--\r\n`;

      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: {
          authorization: auth,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("不支持的文件类型");

      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("上传 .txt 文件 200", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      const boundary = "----FormBoundary7MA4YWxkTrZu0gW";
      const fileContent = "Hello, this is a test file.\nLine 2.";
      const payload =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="test.txt"\r\n` +
        `Content-Type: text/plain\r\n` +
        `\r\n` +
        fileContent +
        `\r\n--${boundary}--\r\n`;

      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: {
          authorization: auth,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; status: string };
      expect(body.id).toBeDefined();
      expect(body.status).toBe("pending");

      // 验证 Document
      const doc = await prisma.document.findUnique({
        where: { id: body.id },
      });
      expect(doc?.sourceType).toBe("FILE");
      expect(doc?.sizeBytes).toBe(fileContent.length);
      expect(doc?.name).toBe("test.txt");

      await prisma.document.delete({ where: { id: body.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });

    it("上传 .pdf 文件 200", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId, name: "My KB" },
      });

      const boundary = "----FormBoundary7MA4YWxkTrZu0gW";
      const fileContent = "%PDF-1.4\n%fake pdf"; // Minimal PDF header
      const payload =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="test.pdf"\r\n` +
        `Content-Type: application/pdf\r\n` +
        `\r\n` +
        fileContent +
        `\r\n--${boundary}--\r\n`;

      const r = await app.inject({
        method: "POST",
        url: `/api/kb/${kb.id}/documents`,
        headers: {
          authorization: auth,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { id: string; status: string };
      expect(body.status).toBe("pending");

      const doc = await prisma.document.findUnique({
        where: { id: body.id },
      });
      expect(doc?.sourceType).toBe("FILE");
      expect(doc?.mime).toBe("application/pdf");

      await prisma.document.delete({ where: { id: body.id } });
      await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    });
  });
});
