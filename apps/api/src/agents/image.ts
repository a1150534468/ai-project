import sharp from "sharp";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const AVATAR_MIME = "image/webp";

export class AvatarImageError extends Error {}

export type ImageKind = "png" | "jpeg" | "webp";

/**
 * 只看 magic bytes，不看 Content-Type、不看后缀——两者都由客户端控制。
 * 明确不认 SVG：头像上传通道里不存在 SVG。
 */
export function detectImageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * 校验 + 强制重编码。重编码顺手做掉：剥 EXIF、杀 polyglot（sharp 只认真正的像素数据）、
 * limitInputPixels 防解压炸弹。
 */
export async function normalizeAvatarImage(buf: Buffer): Promise<Buffer> {
  if (buf.length === 0) throw new AvatarImageError("空文件");
  if (buf.length > MAX_AVATAR_BYTES) throw new AvatarImageError("图片不能超过 2MB");
  if (detectImageKind(buf) === null) throw new AvatarImageError("只支持 PNG / JPEG / WEBP");
  try {
    return await sharp(buf, { limitInputPixels: 4096 * 4096 })
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "center" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AvatarImageError("图片解析失败");
  }
}
