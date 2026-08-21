import { describe, expect, it } from "vitest";
import {
  articleWorkflowImageBlobSignatureValid,
  articleWorkflowImageBlobUrl,
  articleWorkflowResponseBodyHtml,
  articleWorkflowResponseImageUrl,
  articleWorkflowSignedImageBlobUrl,
  articleWorkflowStableBodyHtml,
  ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS,
} from "./article-workflow-image-url.js";

const env = { SESSION_SECRET: "x".repeat(48) } as unknown as NodeJS.ProcessEnv;
const NOW = 1_700_000_000_000;

function paramsOf(url: string) {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

describe("图文配图签名地址", () => {
  it("签名地址带 exp 与 sig，且能被自己验过", () => {
    const url = articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env, nowMs: NOW });
    const params = paramsOf(url);
    expect(url.startsWith(articleWorkflowImageBlobUrl("asset-1"))).toBe(true);
    expect(params.get("exp")).toBe(String(NOW + ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-1",
        expiresAtMs: Number(params.get("exp")),
        signature: params.get("sig")!,
        env,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("换成别的 assetId 用同一份签名验不过——签名绑定资产", () => {
    const params = paramsOf(articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env, nowMs: NOW }));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-2",
        expiresAtMs: Number(params.get("exp")),
        signature: params.get("sig")!,
        env,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("过期后验不过", () => {
    const params = paramsOf(articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env, nowMs: NOW }));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-1",
        expiresAtMs: Number(params.get("exp")),
        signature: params.get("sig")!,
        env,
        nowMs: NOW + ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS + 1,
      }),
    ).toBe(false);
  });

  it("改 exp 想延期验不过", () => {
    const params = paramsOf(articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env, nowMs: NOW }));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-1",
        expiresAtMs: Number(params.get("exp")) + 3600_000,
        signature: params.get("sig")!,
        env,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("换密钥验不过", () => {
    const params = paramsOf(articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env, nowMs: NOW }));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-1",
        expiresAtMs: Number(params.get("exp")),
        signature: params.get("sig")!,
        env: { SESSION_SECRET: "y".repeat(48) } as unknown as NodeJS.ProcessEnv,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("没有可用密钥时退回稳定地址，且任何签名都验不过", () => {
    const bare = {} as NodeJS.ProcessEnv;
    expect(articleWorkflowSignedImageBlobUrl({ assetId: "asset-1", env: bare, nowMs: NOW }))
      .toBe(articleWorkflowImageBlobUrl("asset-1"));
    expect(
      articleWorkflowImageBlobSignatureValid({
        assetId: "asset-1",
        expiresAtMs: NOW + 1000,
        signature: "whatever",
        env: bare,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("非代理地址不签：http 与 data URL 原样返回", () => {
    for (const url of ["https://cdn.example.com/a.png", "data:image/png;base64,AAAA", ""]) {
      expect(articleWorkflowResponseImageUrl({ url, env, nowMs: NOW })).toBe(url);
    }
  });
});

describe("正文地址的出参/落库互转", () => {
  const html = [
    "<h1>标题</h1>",
    `<section data-ai-assistant-image-slot="hero"><img src="${articleWorkflowImageBlobUrl("a1")}" alt="封面" /></section>`,
    `<section data-ai-assistant-image-slot="mid"><img src="${articleWorkflowImageBlobUrl("a2")}" alt="配图" /></section>`,
    '<p>正文里的 &amp; 与 <a href="https://x.test/?a=1&amp;b=2">外链</a>不受影响</p>',
  ].join("");

  it("出参把每张图换成签名地址，& 按 HTML 属性转义", () => {
    const out = articleWorkflowResponseBodyHtml({ html, env, nowMs: NOW });
    expect(out).toContain("&amp;sig=");
    // 裸 & 会让编辑器回传的正文过不了 XML 解析，整篇存不进去
    expect(out).not.toContain("&sig=");
    expect(out.match(/exp=/g)).toHaveLength(2);
    expect(out).toContain('href="https://x.test/?a=1&amp;b=2"');
  });

  it("出参 → 落库 能还原成原样，往返无损", () => {
    const out = articleWorkflowResponseBodyHtml({ html, env, nowMs: NOW });
    expect(articleWorkflowStableBodyHtml(out)).toBe(html);
  });

  it("落库形态再落库一次不变（幂等）", () => {
    expect(articleWorkflowStableBodyHtml(html)).toBe(html);
  });

  it("没有代理地址的正文原样返回，不做无谓改写", () => {
    const plain = '<h1>标题</h1><p>没有配图</p><img src="https://cdn.example.com/a.png" />';
    expect(articleWorkflowResponseBodyHtml({ html: plain, env, nowMs: NOW })).toBe(plain);
    expect(articleWorkflowStableBodyHtml(plain)).toBe(plain);
  });

  it("客户端回传的签名地址不会被叠加第二层签名", () => {
    const once = articleWorkflowResponseBodyHtml({ html, env, nowMs: NOW });
    const twice = articleWorkflowResponseBodyHtml({ html: once, env, nowMs: NOW });
    expect(twice).toBe(once);
    expect(twice.match(/sig=/g)).toHaveLength(2);
  });
});
