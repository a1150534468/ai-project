/**
 * `GET /api/assets` 只做**查询解析**，所以这里只钉解析契约：谁能进、参数怎么收敛、
 * 解出来的东西原样交给 `listAssets`。归并与分页的正确性在 asset-service.test.ts，
 * 六个源的 SQL 真能跑在 asset-sources.integration.test.ts。
 *
 * 用裸 Fastify 而不是 `buildServer()`：本文件的守卫是插件级 `preHandler`，
 * 单独注册这一个插件时它必须依然生效（见 auth/require-user.ts 的说明）。
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAssetCursor } from "./asset-cursor.js";
import type { ListAssetsQuery } from "./asset-service.js";
import type { AssetSourceDeps } from "./asset-sources.js";
import type { AssetPage } from "./asset-types.js";

// 参数带上真实签名，`mock.calls[0][1]` 才是 ListAssetsQuery 而不是空元组。
const listAssets = vi.fn(
  async (_deps: AssetSourceDeps, _query: ListAssetsQuery): Promise<AssetPage> => ({ items: [], nextCursor: null }),
);

vi.mock("@ai-assistant/db", () => ({ getPrisma: () => ({}) }));
vi.mock("./asset-service.js", async () => {
  const actual = await vi.importActual<typeof import("./asset-service.js")>("./asset-service.js");
  return { ...actual, listAssets };
});

/** `userId` 为空字符串 = 未登录：server.ts 的 onRequest 钩子解不出 token 时就是这个状态。 */
async function makeApp(userId = "") {
  const { assetRoutes } = await import("./asset-routes.js");
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(assetRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listAssets.mockResolvedValue({ items: [], nextCursor: null });
});

describe("GET /api/assets 准入", () => {
  it("未登录 401，且不查库", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/assets" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "未登录" });
    expect(listAssets).not.toHaveBeenCalled();
    await app.close();
  });

  it("已登录只看自己的素材：userId 来自 token，不从 query 收", async () => {
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: "/api/assets?userId=user-2" });
    expect(response.statusCode).toBe(200);
    expect(listAssets.mock.calls[0]?.[1]).toMatchObject({ userId: "user-1" });
    await app.close();
  });
});

describe("GET /api/assets 参数解析", () => {
  it("不带参数时用缺省：limit 交给服务层收敛，两个过滤为 null", async () => {
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: "/api/assets", headers: {} });
    expect(response.statusCode).toBe(200);
    expect(listAssets.mock.calls[0]?.[1]).toEqual({
      userId: "user-1",
      limit: undefined,
      cursor: null,
      sourceModule: null,
      origin: null,
    });
    await app.close();
  });

  it("limit 从字符串收成数字", async () => {
    const app = await makeApp("user-1");
    await app.inject({ method: "GET", url: "/api/assets?limit=5" });
    expect(listAssets.mock.calls[0]?.[1]).toMatchObject({ limit: 5 });
    await app.close();
  });

  it("过滤参数原样透传", async () => {
    const app = await makeApp("user-1");
    await app.inject({ method: "GET", url: "/api/assets?sourceModule=portrait&origin=upload" });
    expect(listAssets.mock.calls[0]?.[1]).toMatchObject({ sourceModule: "portrait", origin: "upload" });
    await app.close();
  });

  it("合法游标解成 (createdAt, id)", async () => {
    const createdAt = new Date("2026-08-31T10:00:00.123Z");
    const raw = encodeAssetCursor({ createdAt, id: "dub:p1:final" });
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: `/api/assets?cursor=${raw}` });
    expect(response.statusCode).toBe(200);
    expect(listAssets.mock.calls[0]?.[1]).toMatchObject({ cursor: { createdAt, id: "dub:p1:final" } });
    await app.close();
  });

  it("游标解不出来当没带处理（回第一页），不报错", async () => {
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: "/api/assets?cursor=not-a-cursor" });
    expect(response.statusCode).toBe(200);
    expect(listAssets.mock.calls[0]?.[1]).toMatchObject({ cursor: null });
    await app.close();
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["limit 为 0", "limit=0"],
    ["limit 越上限", "limit=101"],
    ["limit 不是数字", "limit=abc"],
    ["limit 不是整数", "limit=2.5"],
    ["未知 sourceModule", "sourceModule=knowledge"],
    ["未知 origin", "origin=system"],
    ["游标为空串", "cursor="],
    ["游标超长", `cursor=${"a".repeat(401)}`],
  ];

  it.each(rejected)("400：%s", async (_label, query) => {
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: `/api/assets?${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "参数不合法" });
    expect(listAssets).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/assets 响应", () => {
  it("原样返回服务层给的一页（含 nextCursor）", async () => {
    const page: AssetPage = {
      items: [{
        id: "portrait:o1",
        sourceModule: "portrait",
        origin: "ai",
        mediaType: "image",
        title: "形象照 #1",
        url: "https://example.test/o1",
        thumbnailUrl: "https://example.test/o1",
        mime: "image/png",
        width: 1024,
        height: 1536,
        sizeBytes: 2048,
        durationSec: null,
        createdAt: "2026-08-31T10:00:00.000Z",
        groupKey: "task-1",
        groupLabel: null,
      }],
      nextCursor: "abc",
    };
    listAssets.mockResolvedValue(page);
    const app = await makeApp("user-1");
    const response = await app.inject({ method: "GET", url: "/api/assets" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    await app.close();
  });
});
