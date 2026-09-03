/**
 * `listAssets` 只干一件事：把可选参数拼成 query string。会错的地方全在「空值怎么办」——
 * 服务端对 `cursor` 的下限是 1 个字符，`?cursor=` 是 400 而不是「回第一页」，
 * 所以 null/空串必须**整个键不出现**，而不是出现一个空值。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAssets } from "./assetApi";

afterEach(() => vi.unstubAllGlobals());

function stubOk(body: unknown = { items: [], nextCursor: null }) {
  // 参数写全，`mock.calls[0][0]` 才是 string 而不是空元组。
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listAssets", () => {
  it("不带参数时是干净的路径，且带上 bearer", async () => {
    const fetchMock = stubOk();
    await expect(listAssets("token-1")).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assets");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets",
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer token-1" } }),
    );
  });

  it("四个参数都给时按 limit/cursor/sourceModule/origin 顺序拼", async () => {
    const fetchMock = stubOk();
    await listAssets("t", { limit: 30, cursor: "c-1", sourceModule: "codex-pet", origin: "ai" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assets?limit=30&cursor=c-1&sourceModule=codex-pet&origin=ai");
  });

  it("游标里的特殊字符做转义（base64url 不会带，但游标格式是服务端的事）", async () => {
    const fetchMock = stubOk();
    await listAssets("t", { cursor: "a+b/c=" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assets?cursor=a%2Bb%2Fc%3D");
  });

  const empties: ReadonlyArray<readonly [string, Parameters<typeof listAssets>[1]]> = [
    ["cursor 为 null", { cursor: null }],
    ["cursor 为空串", { cursor: "" }],
    ["sourceModule 为 null", { sourceModule: null }],
    ["origin 为 null", { origin: null }],
  ];

  it.each(empties)("%s 时该键完全不出现", async (_label, query) => {
    const fetchMock = stubOk();
    await listAssets("t", query);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assets");
  });

  it("limit=0 也照发（合法性由服务端判，前端不悄悄改用户给的值）", async () => {
    const fetchMock = stubOk();
    await listAssets("t", { limit: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assets?limit=0");
  });

  it("裸响应（没有 data 外壳）原样返回", async () => {
    const page = {
      items: [{ id: "portrait:o1", sourceModule: "codex-pet", origin: "ai", mediaType: "image" }],
      nextCursor: "next",
    };
    stubOk(page);
    await expect(listAssets("t")).resolves.toEqual(page);
  });

  it("失败时抛错，错误文案兜底到「获取素材库失败」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(listAssets("t")).rejects.toThrow("获取素材库失败");
  });
});
