import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ImageUrlSignResult } from "../../storage/cos-image-url.js";
import { logUnsignedFallback, sendImageBlob } from "./image-blob-response.js";

/**
 * 这三条断言此前只有第一条有覆盖。签名者原先返回 `string | null`，`null` 折叠了
 * 「本环境没开直连」与「开了 CDN 但这一张签不出来」两种含义，消费方都当回源处理 ——
 * 于是配了 CDN 的环境里任何一张白名单外的图都会静默退化，CDN 白配且无人报警。
 */
async function serve(result: ImageUrlSignResult) {
  const loadStoredImage = vi.fn(async () => Buffer.from("bytes"));
  const onUnsigned = vi.fn();
  const app = Fastify();
  app.get("/blob", async (_req, reply) =>
    sendImageBlob(
      reply,
      { objectKey: "workflow/a.png", mime: "image/png", expiresAt: Date.now() + 60_000 },
      { signImageUrl: async () => result, loadStoredImage, onUnsigned },
    ),
  );
  const response = await app.inject("/blob");
  await app.close();
  return { response, loadStoredImage, onUnsigned };
}

describe("sendImageBlob", () => {
  it("proxy 模式（delivery-disabled）所有请求都回源", async () => {
    const { response, loadStoredImage, onUnsigned } = await serve({ kind: "unsigned", reason: "delivery-disabled" });

    expect(response.statusCode).toBe(200);
    expect(loadStoredImage).toHaveBeenCalledWith("workflow/a.png");
    expect(onUnsigned).toHaveBeenCalledWith("delivery-disabled", expect.objectContaining({ objectKey: "workflow/a.png" }));
  });

  it("CDN 模式下不支持的资产回源，且被记录成可观测事件", async () => {
    const { response, loadStoredImage, onUnsigned } = await serve({ kind: "unsigned", reason: "unsupported-asset" });

    expect(response.statusCode).toBe(200);
    expect(loadStoredImage).toHaveBeenCalled();
    expect(onUnsigned).toHaveBeenCalledWith("unsupported-asset", expect.objectContaining({ objectKey: "workflow/a.png" }));
  });

  it("CDN 模式下支持的资产重定向，且不落库读", async () => {
    const { response, loadStoredImage, onUnsigned } = await serve({ kind: "signed", url: "https://cdn.example.com/workflow/a.png?sign=1&t=2" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://cdn.example.com/workflow/a.png?sign=1&t=2");
    expect(loadStoredImage).not.toHaveBeenCalled();
    expect(onUnsigned).not.toHaveBeenCalled();
  });
});

describe("logUnsignedFallback", () => {
  it("只在「开了直连却签不出来」时告警，proxy 模式保持安静", () => {
    const warn = vi.fn();
    const onUnsigned = logUnsignedFallback({ warn }, "portrait");

    onUnsigned("delivery-disabled", { objectKey: "workflow/a.png", mime: "image/png", expiresAt: 0 });
    expect(warn).not.toHaveBeenCalled();

    onUnsigned("unsupported-asset", { objectKey: "workflow/a.svg", mime: "image/svg+xml", expiresAt: 0 });
    expect(warn).toHaveBeenCalledWith(
      { scope: "portrait", objectKey: "workflow/a.svg", mime: "image/svg+xml" },
      expect.stringContaining("portrait"),
    );
  });
});
