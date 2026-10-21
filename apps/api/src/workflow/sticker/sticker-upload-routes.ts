/**
 * 表情包工坊：参考图上传（multipart → 对象存储）。
 *
 * 返回 referenceObjectKey，创建 pack 时传入。存储从 sticker-route-context
 * 注入（storeReference），不在 handler 内构造 S3 客户端。
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { requireUser } from "../../auth/require-user.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import type { StickerRouteContext } from "./sticker-route-context.js";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function registerStickerUploadRoutes(context: StickerRouteContext): void {
  const { app } = context;
  app.post("/api/workflow/sticker/reference-upload", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;

    const file = await (request as unknown as { file: () => Promise<unknown> }).file().catch(() => null) as {
      file: NodeJS.ReadableStream;
      filename: string;
      mimetype: string;
    } | null;
    if (!file) return reply.code(400).send({ error: "请选择图片文件" });
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return reply.code(400).send({ error: "只支持 PNG / JPEG / WebP" });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_REFERENCE_BYTES) {
        return reply.code(413).send({ error: "图片不能超过 10MB" });
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    if (body.byteLength === 0) {
      return reply.code(400).send({ error: "图片文件为空" });
    }
    // 校验真实图片内容：客户端声明的 mimetype 不可信，空文件/任意字节冒充 image/png
    // 在这里拦下，避免进入逐张付费生图与重试流程。
    // metadata() 只读文件头，必须完整解码像素才能拦截「头有效、像素损坏/截断」的文件。
    try {
      const metadata = await sharp(body).metadata();
      if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) {
        return reply.code(400).send({ error: "不是有效的图片文件" });
      }
      await sharp(body).toBuffer();
    } catch {
      return reply.code(400).send({ error: "不是有效的图片文件" });
    }
    const extension = file.mimetype === "image/jpeg" ? "jpg" : file.mimetype === "image/webp" ? "webp" : "png";
    const key = `workflow/stickers/${userId}/reference-${randomUUID()}.${extension}`;

    try {
      await context.storeReference(key, body, file.mimetype);
    } catch (error) {
      const detail = errorMessageOrFallback(error, "请稍后重试");
      return reply.code(500).send({ error: `参考图上传失败：${detail}` });
    }
    return reply.send({ referenceObjectKey: key });
  });
}
