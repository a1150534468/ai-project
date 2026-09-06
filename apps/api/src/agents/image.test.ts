import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarImageError, MAX_AVATAR_BYTES, detectImageKind, normalizeAvatarImage } from "./image.js";

/**
 * 只把 `loadSharp` 拦下来，其余照常用真的 sharp —— 这一层的用例大半要靠真的编解码器才有意义。
 * 拦它是为了验一条不好造的分支：原生模块装不上的时候，错误**不能**被当成「用户的图片有问题」。
 */
const sharpLoader = vi.hoisted(() => ({ fail: false }));

vi.mock("../runtime/resource-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/resource-limits.js")>();
  return {
    ...actual,
    loadSharp: async () => {
      if (sharpLoader.fail) throw new Error("sharp binding missing");
      return actual.loadSharp();
    },
  };
});

afterEach(() => {
  sharpLoader.fail = false;
});

const square = (format: "png" | "jpeg" | "webp") =>
  sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } })[format]().toBuffer();

/** 头是 PNG、身子是 SVG。magic bytes 这一层挡不住它，只有真的解码才能。 */
const polyglot = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("<svg onload=x>")]);

describe("detectImageKind", () => {
  it("认出 PNG / JPEG / WEBP", async () => {
    expect(detectImageKind(await square("png"))).toBe("png");
    expect(detectImageKind(await square("jpeg"))).toBe("jpeg");
    expect(detectImageKind(await square("webp"))).toBe("webp");
  });

  // SVG 是能带脚本的文档，不是像素；这条通道里它一律不认，跟文件名叫什么无关
  it("不认 SVG", () => {
    expect(detectImageKind(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();
  });

  it("不认 GIF、纯文本、空文件", () => {
    expect(detectImageKind(Buffer.from("GIF89a"))).toBeNull();
    expect(detectImageKind(Buffer.from("hello"))).toBeNull();
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });

  it("只看文件头，所以 polyglot 能过这一层", () => {
    expect(detectImageKind(polyglot())).toBe("png");
  });
});

describe("normalizeAvatarImage", () => {
  it("一律重编码成 256×256 的 webp", async () => {
    const meta = await sharp(await normalizeAvatarImage(await square("png"))).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("非正方形也按 cover 裁成正方形，不留白", async () => {
    const wide = await sharp({ create: { width: 200, height: 50, channels: 3, background: "#fff" } }).png().toBuffer();
    const meta = await sharp(await normalizeAvatarImage(wide)).metadata();

    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("空文件 → AvatarImageError", async () => {
    await expect(normalizeAvatarImage(Buffer.alloc(0))).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("超过 2MB → AvatarImageError（不进解码器）", async () => {
    await expect(normalizeAvatarImage(Buffer.alloc(MAX_AVATAR_BYTES + 1))).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("SVG → AvatarImageError", async () => {
    await expect(normalizeAvatarImage(Buffer.from("<svg/>"))).rejects.toBeInstanceOf(AvatarImageError);
  });

  // 这才是重编码的意义：magic 骗得过，像素骗不过
  it("polyglot 过了 magic 也会死在解码上 → AvatarImageError", async () => {
    await expect(normalizeAvatarImage(polyglot())).rejects.toBeInstanceOf(AvatarImageError);
  });

  // 包进 AvatarImageError 就会变成一条 400「图片解析失败」，
  // 用户会对着一台没装好 sharp 的机器反复换图 —— 那是部署问题，必须让它变成 500
  it("sharp 装不上时抛的不是 AvatarImageError", async () => {
    sharpLoader.fail = true;

    const err = await normalizeAvatarImage(await square("png")).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AvatarImageError);
  });
});
