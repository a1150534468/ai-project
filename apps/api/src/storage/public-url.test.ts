import { describe, it, expect } from "vitest";
import { publicObjectUrl } from "./public-url.js";
import type { S3Config } from "./s3.js";

const cfg: S3Config = {
  endpoint: "https://oss.example.com",
  region: "r",
  bucket: "buck",
  accessKey: "a",
  secretKey: "s",
  forcePathStyle: false,
};

describe("publicObjectUrl", () => {
  it("优先用 S3_PUBLIC_BASE_URL", () => {
    expect(publicObjectUrl(cfg, "a/b.webp", { S3_PUBLIC_BASE_URL: "https://cdn.x/" })).toBe(
      "https://cdn.x/a/b.webp",
    );
  });

  it("path-style", () => {
    expect(
      publicObjectUrl({ ...cfg, forcePathStyle: true }, "a/b.webp", {})
    ).toBe("https://oss.example.com/buck/a/b.webp");
  });

  it("virtual-host style", () => {
    expect(publicObjectUrl(cfg, "a/b.webp", {})).toBe("https://buck.oss.example.com/a/b.webp");
  });

  it("key 分段做 URL 编码，不吃掉斜杠", () => {
    expect(publicObjectUrl(cfg, "a b/c+d.webp", {})).toBe(
      "https://buck.oss.example.com/a%20b/c%2Bd.webp",
    );
  });

  it("保留 endpoint 的端口和路径前缀", () => {
    const endpoint = { ...cfg, endpoint: "http://localhost:9000/root", forcePathStyle: true };
    expect(publicObjectUrl(endpoint, "a.png", {})).toBe("http://localhost:9000/root/buck/a.png");
  });
});
