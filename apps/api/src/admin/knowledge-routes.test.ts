import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";
import * as billingModule from "@ai-assistant/billing";

// Mock @ai-assistant/billing 在模块顶层
vi.mock("@ai-assistant/billing", () => ({
  createBillingClient: vi.fn(),
  InsufficientBalanceError: class extends Error {
    name = "InsufficientBalanceError";
    constructor() {
      super("积分不足");
    }
  },
}));

// Mock indexOnce 避免真实索引
vi.mock("../kb/indexer.js", () => ({
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
let superAdminToken = "";
let userManageToken = "";
let noPermToken = "";

// 收集清理用的 id
const createdAdminIds: string[] = [];
const createdKbIds: string[] = [];
const createdUserIds: string[] = [];
const createdGrantIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.EMBEDDING_MODEL ??= "test-embedding-model";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1";
  process.env.BILLING_INTERNAL_TOKEN ??= "internal-token";
  process.env.S3_ENDPOINT ??= "http://localhost:9000";
  process.env.S3_BUCKET ??= "test-kb";
  process.env.S3_ACCESS_KEY ??= "test-s3-access-key";
  process.env.S3_SECRET_KEY ??= "test-s3-secret-key";

  // 设置默认 mock
  vi.mocked(billingModule.createBillingClient).mockReturnValue({
    reserve: vi.fn().mockResolvedValue({ opId: "mock-op-id" }),
    settle: vi.fn().mockResolvedValue({ settled: true }),
    getUserKbQuota: vi.fn().mockResolvedValue({ membershipBytes: 1000000, defaultBytes: 1000000 }),
    listMembershipCards: vi.fn().mockResolvedValue({ data: [] }),
  } as any);

  const secret = process.env.ADMIN_SESSION_SECRET!;

  // 创建 super_admin
  const superAdmin = await createAdmin(prisma, {
    username: `kbadm_super_${Date.now()}`,
    password: "password123",
    role: "super_admin",
    permissions: [],
  });
  createdAdminIds.push(superAdmin.id);
  superAdminToken = signAdminToken(superAdmin.id, secret);

  // 创建有 KNOWLEDGE_MANAGE 的 admin
  const kbManageAdmin = await createAdmin(prisma, {
    username: `kbadm_kbmgr_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["KNOWLEDGE_MANAGE"],
  });
  createdAdminIds.push(kbManageAdmin.id);

  // 创建有 USER_MANAGE 的 admin
  const userManageAdmin = await createAdmin(prisma, {
    username: `kbadm_usermgr_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["USER_MANAGE"],
  });
  createdAdminIds.push(userManageAdmin.id);
  userManageToken = signAdminToken(userManageAdmin.id, secret);

  // 创建无权限的 admin
  const noPerm = await createAdmin(prisma, {
    username: `kbadm_noperm_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["ANNOUNCEMENT_MANAGE"],
  });
  createdAdminIds.push(noPerm.id);
  noPermToken = signAdminToken(noPerm.id, secret);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();

  // 清理：按 id-scoped 顺序删除
  // 先删文档和 chunk（有 FK）
  for (const kbId of createdKbIds) {
    await prisma.chunk.deleteMany({ where: { document: { kbId } } });
    await prisma.document.deleteMany({ where: { kbId } });
  }
  // 再删知识库
  for (const kbId of createdKbIds) {
    await prisma.knowledgeBase.deleteMany({ where: { id: kbId } });
  }
  // 删 grant
  for (const grantId of createdGrantIds) {
    await prisma.kbQuotaGrant.deleteMany({ where: { id: grantId } });
  }
  // 新用户会自动获得 AI 产物系统库。
  await prisma.knowledgeBase.deleteMany({ where: { userId: { in: createdUserIds } } });
  // 删 user
  for (const uid of createdUserIds) {
    await prisma.user.deleteMany({ where: { id: uid } });
  }
  // 删审计
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  // 删 admin
  for (const adminId of createdAdminIds) {
    await prisma.admin.deleteMany({ where: { id: adminId } });
  }
});

describe("admin 知识库管理路由", () => {
  describe("权限检查", () => {
    it("无 KNOWLEDGE_MANAGE 权限访问官方库端点返回 403", async () => {
      const r = await app.inject({
        method: "GET",
        url: "/api/admin/kb",
        headers: { authorization: `Bearer ${noPermToken}` },
      });
      expect(r.statusCode).toBe(403);
    });

    it("无 USER_MANAGE 权限调配额端点返回 403", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/users/test-user/kb-quota",
        headers: { authorization: `Bearer ${noPermToken}`, "content-type": "application/json" },
        payload: { bytes: 1000000 },
      });
      expect(r.statusCode).toBe(403);
    });
  });

  describe("官方库 CRUD", () => {
    it("POST /api/admin/kb 建官方库成功", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/kb",
        headers: { authorization: `Bearer ${superAdminToken}`, "content-type": "application/json" },
        payload: { name: "Official KB Test", description: "Test official KB" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.success).toBe(true);
      expect(body.data.ownerType).toBe("OFFICIAL");
      expect(body.data.name).toBe("Official KB Test");
      createdKbIds.push(body.data.id);
    });

    it("GET /api/admin/kb 列官方库", async () => {
      // 先建一个库
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Test Official" },
      });
      createdKbIds.push(kb.id);

      const r = await app.inject({
        method: "GET",
        url: "/api/admin/kb",
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((k: any) => k.id === kb.id && k.ownerType === "OFFICIAL")).toBe(true);
    });

    it("PATCH /api/admin/kb/:id 改官方库信息成功", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Original Name" },
      });
      createdKbIds.push(kb.id);

      const r = await app.inject({
        method: "PATCH",
        url: `/api/admin/kb/${kb.id}`,
        headers: { authorization: `Bearer ${superAdminToken}`, "content-type": "application/json" },
        payload: { name: "Updated Name", description: "New description" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.data.name).toBe("Updated Name");
      expect(body.data.description).toBe("New description");
    });

    it("PATCH /api/admin/kb/:id 对非官方库返回 404", async () => {
      const userKb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "User KB" },
      });
      createdKbIds.push(userKb.id);

      const r = await app.inject({
        method: "PATCH",
        url: `/api/admin/kb/${userKb.id}`,
        headers: { authorization: `Bearer ${superAdminToken}`, "content-type": "application/json" },
        payload: { name: "New Name" },
      });
      expect(r.statusCode).toBe(404);
    });

    it("DELETE /api/admin/kb/:id 删官方库成功", async () => {
      const kb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "KB to Delete" },
      });

      const r = await app.inject({
        method: "DELETE",
        url: `/api/admin/kb/${kb.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(204);

      const check = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
      expect(check).toBeNull();
    });

    it("DELETE /api/admin/kb/:id 对非官方库返回 404", async () => {
      const userKb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "User KB" },
      });
      createdKbIds.push(userKb.id);

      const r = await app.inject({
        method: "DELETE",
        url: `/api/admin/kb/${userKb.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(404);
    });
  });

  describe("官方库文档管理", () => {
    let officialKb: any;

    beforeEach(async () => {
      officialKb = await prisma.knowledgeBase.create({
        data: { ownerType: "OFFICIAL", name: "Doc Test KB" },
      });
      createdKbIds.push(officialKb.id);
    });

    it("GET /api/admin/kb/:id/documents 列文档", async () => {
      const doc = await prisma.document.create({
        data: {
          kbId: officialKb.id,
          name: "test.txt",
          sourceType: "TEXT",
          sourceUri: "kb/xxx/yyy/test.txt",
          mime: "text/plain",
          sizeBytes: 100,
          status: "ready",
          chunkCount: 1,
        },
      });

      const r = await app.inject({
        method: "GET",
        url: `/api/admin/kb/${officialKb.id}/documents`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.success).toBe(true);
      expect(body.data.some((d: any) => d.id === doc.id)).toBe(true);
    });

    it("GET /api/admin/kb/:id/documents 对非官方库返回 404", async () => {
      const userKb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "User KB" },
      });
      createdKbIds.push(userKb.id);

      const r = await app.inject({
        method: "GET",
        url: `/api/admin/kb/${userKb.id}/documents`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(404);
    });

    it("POST /api/admin/kb/:id/documents 加文本文档，不调 billing.reserve", async () => {
      // 获取 mock 的 createBillingClient 函数
      const createBillingMock = vi.mocked(billingModule.createBillingClient);
      // 获取上次调用返回的 mock billing 实例
      const mockBilling = createBillingMock.mock.results[0]?.value;

      const r = await app.inject({
        method: "POST",
        url: `/api/admin/kb/${officialKb.id}/documents`,
        headers: { authorization: `Bearer ${superAdminToken}`, "content-type": "application/json" },
        payload: { text: "Hello official KB" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(body.data.status).toBe("pending");

      // 核心验证：reserve 未被调用（skipQuotaCheck=true）
      if (mockBilling && mockBilling.reserve) {
        expect(mockBilling.reserve).toHaveBeenCalledTimes(0);
      }
    });

    it("DELETE /api/admin/kb/:id/documents/:docId 删文档成功", async () => {
      const doc = await prisma.document.create({
        data: {
          kbId: officialKb.id,
          name: "doc-to-delete.txt",
          sourceType: "TEXT",
          sourceUri: "kb/xxx/yyy/doc.txt",
          mime: "text/plain",
          sizeBytes: 100,
          status: "ready",
        },
      });

      const r = await app.inject({
        method: "DELETE",
        url: `/api/admin/kb/${officialKb.id}/documents/${doc.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(204);

      const check = await prisma.document.findUnique({ where: { id: doc.id } });
      expect(check).toBeNull();
    });

    it("DELETE /api/admin/kb/:id/documents/:docId 对非官方库返回 404", async () => {
      const userKb = await prisma.knowledgeBase.create({
        data: { ownerType: "USER", userId: randomUUID(), name: "User KB" },
      });
      const userDoc = await prisma.document.create({
        data: {
          kbId: userKb.id,
          name: "user-doc.txt",
          sourceType: "TEXT",
          sourceUri: "kb/xxx/yyy/user.txt",
          status: "ready",
          chunkCount: 0,
        },
      });
      createdKbIds.push(userKb.id);

      const r = await app.inject({
        method: "DELETE",
        url: `/api/admin/kb/${userKb.id}/documents/${userDoc.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(404);
    });
  });

  describe("配额包已下线", () => {
    it("不再注册配额包管理端点", async () => {
      const r = await app.inject({
        method: "GET",
        url: "/api/admin/kb-quota-packages",
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(r.statusCode).toBe(404);
    });
  });

  describe("用户配额管理", () => {
    let testUser: any;

    beforeEach(async () => {
      testUser = await prisma.user.create({
        data: { uid: `user_${Date.now()}`, username: `testuser_${Date.now()}`, passwordHash: "xxx" },
      });
      createdUserIds.push(testUser.id);
    });

    it("POST /api/admin/users/:id/kb-quota 给用户配额成功", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/users/${testUser.id}/kb-quota`,
        headers: { authorization: `Bearer ${userManageToken}`, "content-type": "application/json" },
        payload: { bytes: 5000000, note: "admin grant" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.success).toBe(true);
      expect(body.data.bytes).toBe(5000000);
      expect(body.data.source).toBe("ADMIN");
      createdGrantIds.push(body.data.id);
    });

    it("POST /api/admin/users/:id/kb-quota bytes≤0 返回 400", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/users/${testUser.id}/kb-quota`,
        headers: { authorization: `Bearer ${userManageToken}`, "content-type": "application/json" },
        payload: { bytes: 0 },
      });
      expect(r.statusCode).toBe(400);
    });

    it("POST /api/admin/users/:id/kb-quota 用户不存在返回 404", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/users/${randomUUID()}/kb-quota`,
        headers: { authorization: `Bearer ${userManageToken}`, "content-type": "application/json" },
        payload: { bytes: 1000000 },
      });
      expect(r.statusCode).toBe(404);
    });

    it("POST /api/admin/users/:id/kb-quota 带 expiresAt 过期时间", async () => {
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/users/${testUser.id}/kb-quota`,
        headers: { authorization: `Bearer ${userManageToken}`, "content-type": "application/json" },
        payload: { bytes: 1000000, expiresAt: futureDate },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      expect(body.data.expiresAt).toBeDefined();
      createdGrantIds.push(body.data.id);
    });
  });

  describe("审计记录", () => {
    it("KB_CREATE 审计", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/kb",
        headers: { authorization: `Bearer ${superAdminToken}`, "content-type": "application/json" },
        payload: { name: "Audit Test KB" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as any;
      const kbId = body.data.id;
      createdKbIds.push(kbId);

      const audits = await prisma.adminAudit.findMany({
        where: { action: "KB_CREATE", target: kbId },
      });
      expect(audits.length).toBeGreaterThan(0);
    });

    it("USER_KB_QUOTA_GRANT 审计", async () => {
      const testUser = await prisma.user.create({
        data: { uid: `user_audit_${Date.now()}`, username: `audituser_${Date.now()}`, passwordHash: "xxx" },
      });
      createdUserIds.push(testUser.id);

      const r = await app.inject({
        method: "POST",
        url: `/api/admin/users/${testUser.id}/kb-quota`,
        headers: { authorization: `Bearer ${userManageToken}`, "content-type": "application/json" },
        payload: { bytes: 1000000 },
      });
      expect(r.statusCode).toBe(200);

      const audits = await prisma.adminAudit.findMany({
        where: { action: "USER_KB_QUOTA_GRANT", target: testUser.id },
      });
      expect(audits.length).toBeGreaterThan(0);
    });
  });
});
