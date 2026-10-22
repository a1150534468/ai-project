import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSignedBlobUrl,
  verifyPayloadSignature,
  verifySignedBlobUrl,
  type SignedBlobUrlConfig,
} from "./signed-blob-url.js";

const SECRET = "test-secret-at-least-16-chars";
const config: SignedBlobUrlConfig = {
  resolveSecret: () => SECRET,
  ttlMs: 15 * 60 * 1000,
  buildPath: (kind, id) => `/api/workflow/try-ons/${kind === "reference" ? "references" : "outputs"}/${id}/blob`,
};

function issue(kind: "reference" | "output" = "reference", id = "asset-1", objectKey = "workflow/try-ons/references/u1/asset-1.png") {
  const url = createSignedBlobUrl(config, { kind, id, objectKey });
  const params = new URLSearchParams(url.split("?")[1]);
  return { url, exp: Number(params.get("exp")), sig: params.get("sig") ?? "", kind, id, objectKey };
}

describe("signed-blob-url 冒号族", () => {
  it("签发格式与历史实现逐字一致（hex 签名 + 秒级 exp + 冒号 payload）", () => {
    const { url, exp, sig } = issue();
    const expectedSig = createHmac("sha256", SECRET)
      .update(`reference:asset-1:workflow/try-ons/references/u1/asset-1.png:${exp}`)
      .digest("hex");
    expect(sig).toBe(expectedSig);
    expect(url).toBe(`/api/workflow/try-ons/references/asset-1/blob?exp=${exp}&sig=${expectedSig}`);
    expect(verifySignedBlobUrl(config, { kind: "reference", id: "asset-1", objectKey: "workflow/try-ons/references/u1/asset-1.png", exp, sig })).toBe(true);
  });

  it("过期被拒", () => {
    const { exp, sig, kind, id, objectKey } = issue();
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const pastSig = createHmac("sha256", SECRET).update(`${kind}:${id}:${objectKey}:${pastExp}`).digest("hex");
    expect(verifySignedBlobUrl(config, { kind, id, objectKey, exp: pastExp, sig: pastSig })).toBe(false);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(sig).toBeTruthy();
  });

  it("篡改被拒（改 id / 改 objectKey / 改签名任一处）", () => {
    const { exp, sig, kind, id, objectKey } = issue();
    expect(verifySignedBlobUrl(config, { kind, id: "asset-2", objectKey, exp, sig })).toBe(false);
    expect(verifySignedBlobUrl(config, { kind, id, objectKey: "workflow/try-ons/references/u1/other.png", exp, sig })).toBe(false);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifySignedBlobUrl(config, { kind, id, objectKey, exp, sig: flipped })).toBe(false);
  });

  it("长度不等的签名被拒且不抛异常", () => {
    const { exp, kind, id, objectKey } = issue();
    expect(() => verifySignedBlobUrl(config, { kind, id, objectKey, exp, sig: "abc" })).not.toThrow();
    expect(verifySignedBlobUrl(config, { kind, id, objectKey, exp, sig: "abc" })).toBe(false);
    expect(verifySignedBlobUrl(config, { kind, id, objectKey, exp, sig: "" })).toBe(false);
  });

  it("跨 kind 混淆被拒：reference 的签名不能用于 output", () => {
    const { exp, sig, id, objectKey } = issue("reference");
    expect(verifySignedBlobUrl(config, { kind: "output", id, objectKey, exp, sig })).toBe(false);
  });
});

describe("verifyPayloadSignature 原语", () => {
  it("base64url 编码下验签通过、错 secret 被拒", () => {
    const payload = "img-1\nworkflow/images/u1/a.png\n1893456000000";
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyPayloadSignature(SECRET, payload, sig, "base64url")).toBe(true);
    expect(verifyPayloadSignature("another-secret-0123456789", payload, sig, "base64url")).toBe(false);
  });
});
