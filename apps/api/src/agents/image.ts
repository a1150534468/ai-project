import { loadSharp } from "../runtime/resource-limits.js";

/** 上传头像的字节上限。比这个大的直接拒，不进解码器 —— 省 CPU，也少一条被喂炸弹的路。 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** 出片边长。头像只在 24~96px 之间显示，256 已经够两倍屏用了。 */
export const AVATAR_SIZE = 256;

/** 出片格式。存进对象存储的 key 也用 `.webp` 结尾，两边必须一致。 */
export const AVATAR_MIME = "image/webp";

/**
 * 「这张图不合格」。路由层认这个类型 → 400，其他异常一律往上抛 → 500。
 * 所以什么算 `AvatarImageError` 是有分量的：**基础设施故障绝不能塞进来**，
 * 否则 sharp 装不上会显示成「你的图片有问题」，用户改到死也没用。
 */
export class AvatarImageError extends Error {}

export type ImageKind = "png" | "jpeg" | "webp";

/**
 * 认格式只看文件头的 magic bytes。
 *
 * 不看 `Content-Type`、不看文件名后缀 —— 这两样都是客户端说了算的，不构成任何证据。
 *
 * 名单里**故意没有 SVG**：SVG 是能带脚本的文档而不是像素，头像上传这条通道不需要它
 * （Agent 的矢量头像走另一条路，见 avatar.ts 的白名单清洗），所以这里连门都不开。
 */
export function detectImageKind(buf: Buffer): ImageKind | null {
  // PNG：固定 8 字节签名，这里查前 4 个（\x89 P N G）就足够区分了。
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  // JPEG：SOI 标记 FF D8 紧跟着下一个标记的 FF。
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // WEBP 是 RIFF 容器：0..4 是 "RIFF"，4..8 是长度（跳过），8..12 才是 "WEBP"。
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * 校验并**强制重编码**成 webp。返回可以直接落对象存储的字节。
 *
 * 重编码不是为了省流量，是三件安全事顺手一起做掉：
 *
 * - 剥掉 EXIF —— 手机拍的图里带 GPS 坐标，头像是公开可见的；
 * - 干掉 polyglot —— 前缀伪装成 PNG、后面挂一段别的格式/脚本的文件能骗过 magic bytes，
 *   但骗不过解码器，因为输出的是 sharp 重新画出来的像素；
 * - `limitInputPixels` 挡解压炸弹 —— 几十 KB 的文件可以声明成十万乘十万的画布。
 *
 * `loadSharp()` **故意放在 try 外面**。它失败意味着原生模块没装好，是部署问题而不是这张图的问题；
 * 包进 try 就会变成一条 400「图片解析失败」，让用户对着一台坏机器反复换图。
 */
export async function normalizeAvatarImage(buf: Buffer): Promise<Buffer> {
  if (buf.length === 0) throw new AvatarImageError("空文件");
  if (buf.length > MAX_AVATAR_BYTES) throw new AvatarImageError("图片不能超过 2MB");
  if (detectImageKind(buf) === null) throw new AvatarImageError("只支持 PNG / JPEG / WEBP");

  const sharp = await loadSharp();

  try {
    return await sharp(buf, { limitInputPixels: 4096 * 4096 })
      // cover + center：宁可裁掉边缘也要填满正方形，头像框里不能出现留白。
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "center" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    // 到这里说明字节确实解不开（截断、声明的尺寸对不上、超过像素上限……），这才是用户的问题。
    throw new AvatarImageError("图片解析失败");
  }
}
