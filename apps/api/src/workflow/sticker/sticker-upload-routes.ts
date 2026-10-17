/**
 * 表情包工坊：参考图上传（multipart → 对象存储）。
 *
 * 返回 referenceObjectKey，创建 pack 时传入。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadS3Config, makeS3, putObject } from "../../storage/s3.js";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function registerStickerUploadRoutes(app: FastifyInstance): void {
  app.post("/api/workflow/sticker/reference-upload", async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
    const extension = file.mimetype === "image/jpeg" ? "jpg" : file.mimetype === "image/webp" ? "webp" : "png";
    const key = `workflow/stickers/${userId}/reference-${randomUUID()}.${extension}`;

    try {
      const s3 = makeS3(loadS3Config(process.env));
      await putObject(s3, key, body, file.mimetype, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: `参考图上传失败：${message}` });
    }
    return reply.send({ referenceObjectKey: key });
  });
}
