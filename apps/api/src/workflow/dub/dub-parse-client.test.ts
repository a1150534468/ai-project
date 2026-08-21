import { describe, it, expect, vi } from "vitest";
import { loadParseConfig, parseShareUrl } from "./dub-parse-client.js";

describe("loadParseConfig", () => {
  it("缺 clientId/secret 抛错", () => {
    expect(() => loadParseConfig({ DUB_PARSE_CLIENT_ID: "", DUB_PARSE_SECRET_KEY: "" } as NodeJS.ProcessEnv)).toThrow();
  });
  it("有值时读取并默认 baseUrl", () => {
    const cfg = loadParseConfig({ DUB_PARSE_CLIENT_ID: "cid", DUB_PARSE_SECRET_KEY: "sk" } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: "http://apis.ppt6.top", clientId: "cid", secretKey: "sk" });
  });
});

describe("parseShareUrl", () => {
  const cfg = { baseUrl: "http://apis.ppt6.top", clientId: "cid", secretKey: "sk" };

  it("视频帖 code=200 返回 kind=video + 无水印 video_url", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "解析成功", data: { type: 1, desc: "标题", cover: "http://c/1.jpg", video: "http://wm/1.mp4", video_url: "http://nowm/1.mp4", duration: "84" } }), { status: 200 }),
    );
    const r = await parseShareUrl(cfg, "https://v.douyin.com/x", fetchFn);
    expect(r).toEqual({ kind: "video", desc: "标题", cover: "http://c/1.jpg", playAddr: "http://nowm/1.mp4" });
    expect((fetchFn.mock.calls[0][0] as string)).toContain("clientSecretKey=sk");
  });

  it("无 video_url 时兜底用 video", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "解析成功", data: { type: 1, desc: "t", cover: "c", video: "http://wm/2.mp4" } }), { status: 200 }),
    );
    const r = await parseShareUrl(cfg, "https://v.douyin.com/x", fetchFn);
    expect(r.playAddr).toBe("http://wm/2.mp4");
  });

  it("图文帖 type=2 返回 kind=image", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "解析成功", data: { type: 2, desc: "图集", cover: "http://c/1.jpg", pics: ["a"] } }), { status: 200 }),
    );
    const r = await parseShareUrl(cfg, "https://v.douyin.com/x", fetchFn);
    expect(r.kind).toBe("image");
  });

  it("失败码抛错（code 非 200）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: -1, msg: "不支持" }), { status: 200 }));
    await expect(parseShareUrl(cfg, "https://v.douyin.com/x", fetchFn)).rejects.toThrow(/不支持/);
  });
});
