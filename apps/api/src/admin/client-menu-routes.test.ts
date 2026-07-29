import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = {
  clientMenuVisibility: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
};
const requireAdminCalls: string[] = [];
const writeAudit = vi.fn(async () => undefined);

vi.mock("@ai-assistant/db", () => ({ getPrisma: () => mockPrisma }));
vi.mock("./guard.js", () => ({
  requireAdmin: (permission: string) => {
    requireAdminCalls.push(permission);
    return async (req: object) => {
      Object.assign(req, { admin: { id: "admin-1" } });
    };
  },
}));
vi.mock("./audit.js", () => ({ writeAudit }));

async function makeApp() {
  const { clientMenuRoutes } = await import("./client-menu-routes.js");
  const app = Fastify();
  await app.register(clientMenuRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminCalls.length = 0;
  mockPrisma.clientMenuVisibility.findMany.mockResolvedValue([]);
  mockPrisma.clientMenuVisibility.upsert.mockResolvedValue({});
});

describe("client menu routes", () => {
  it("公开接口返回默认配置，并合并数据库覆盖值", async () => {
    mockPrisma.clientMenuVisibility.findMany.mockResolvedValue([
      { key: "workflow.report", visible: true },
    ]);
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/client-menu" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.find((item: { key: string }) => item.key === "workflow.report").visible).toBe(true);
    expect(requireAdminCalls).toEqual(["ADMIN_MANAGE", "ADMIN_MANAGE"]);
    await app.close();
  });

  it("管理员可以修改菜单状态并记录审计", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/client-menu/workflow.report",
      payload: { visible: true },
    });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.clientMenuVisibility.upsert).toHaveBeenCalledWith({
      where: { key: "workflow.report" },
      create: { key: "workflow.report", visible: true },
      update: { visible: true },
    });
    expect(writeAudit).toHaveBeenCalledWith(
      mockPrisma,
      "admin-1",
      "CLIENT_MENU_VISIBILITY_UPDATE",
      "workflow.report",
      { visible: true },
    );
    await app.close();
  });

  it("拒绝目录之外的菜单标识", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/client-menu/not-exists",
      payload: { visible: false },
    });
    expect(response.statusCode).toBe(400);
    expect(mockPrisma.clientMenuVisibility.upsert).not.toHaveBeenCalled();
    await app.close();
  });
});
