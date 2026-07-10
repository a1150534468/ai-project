import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { detectImageKind, normalizeAvatarImage, MAX_AVATAR_BYTES, AvatarImageError } from "./image.js";

const png = () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).png().toBuffer();
const jpeg = () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer();

describe("detectImageKind", () => {
  it("认出 PNG / JPEG / WEBP", async () => {
    expect(detectImageKind(await png())).toBe("png");
    expect(detectImageKind(await jpeg())).toBe("jpeg");
    expect(detectImageKind(await sharp(await png()).webp().toBuffer())).toBe("webp");
  });
  it("拒绝 SVG（哪怕文件名叫 .png）", () => {
    expect(detectImageKind(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();
  });
  it("拒绝 GIF / 纯文本 / 空", () => {
    expect(detectImageKind(Buffer.from("GIF89a"))).toBeNull();
    expect(detectImageKind(Buffer.from("hello"))).toBeNull();
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });
  it("PNG 头 + SVG 体的 polyglot：magic 只看头，这层过得去", () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("<svg onload=x>")]);
    expect(detectImageKind(fake)).toBe("png");
  });
});

describe("normalizeAvatarImage", () => {
  it("重编码为 256x256 webp", async () => {
    const out = await normalizeAvatarImage(await png());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });
  it("超过 2MB → AvatarImageError", async () => {
    await expect(normalizeAvatarImage(Buffer.alloc(MAX_AVATAR_BYTES + 1))).rejects.toBeInstanceOf(AvatarImageError);
  });
  it("SVG → AvatarImageError", async () => {
    await expect(normalizeAvatarImage(Buffer.from("<svg/>"))).rejects.toBeInstanceOf(AvatarImageError);
  });
  it("magic 伪装的 polyglot → AvatarImageError（sharp 解不出）", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("<svg onload=x>")]);
    await expect(normalizeAvatarImage(fake)).rejects.toBeInstanceOf(AvatarImageError);
  });
});
