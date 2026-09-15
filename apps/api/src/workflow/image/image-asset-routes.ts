import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { requireUser } from "../../auth/require-user.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import {
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  storeWorkflowImage,
} from "../_shared/image-service.js";
import type { ImageRouteContext } from "./image-route-context.js";
import {
  hasValidImageBlobAccess,
  imageBlobParamsSchema,
  imageBlobQuerySchema,
  imageReferenceSchema,
  listRecentImages,
  serializeImageRow,
} from "./image-route-helpers.js";

function uploadedImageMime(rawMime: string | undefined): string {
  return rawMime?.split(";", 1)[0]?.trim().toLowerCase() || "image/png";
}

async function isReadableRaster(bytes: Buffer): Promise<boolean> {
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).metadata();
    return Boolean(metadata.width && metadata.height);
  } catch {
    return false;
  }
}

export function registerImageAssetRoutes(context: ImageRouteContext): void {
  const { app, prisma, fetchFn, loadStoredImage } = context;

  app.get("/api/workflow/images/:imageId/blob", async (req, reply) => {
    const params = imageBlobParamsSchema.safeParse(req.params);
    const query = imageBlobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });

    const image = await prisma.imageAsset.findUnique({
      where: { id: params.data.imageId },
      select: { id: true, objectKey: true, mime: true },
    });
    if (!image?.objectKey) return reply.code(404).send({ error: "图片不存在" });
    if (!hasValidImageBlobAccess(image.id, image.objectKey, query.data.exp, query.data.sig)) {
      return reply.code(401).send({ error: "图片地址已失效" });
    }

    try {
      const bytes = await loadStoredImage(image.objectKey);
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(image.mime.startsWith("image/") ? image.mime : "image/png")
        .send(bytes);
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.get("/api/workflow/images", { preHandler: requireUser }, async (req) => ({
    success: true,
    data: (await listRecentImages(prisma, req.userId)).map(serializeImageRow),
  }));

  app.post("/api/workflow/images/references", { preHandler: requireUser }, async (req, reply) => {
    const parsed = imageReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参考图参数不合法" });

    const bytes = Buffer.from(parsed.data.image.b64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
      return reply.code(400).send({ error: "参考图大小需在 10MB 以内" });
    }
    const mime = uploadedImageMime(parsed.data.image.mime);
    if (!IMAGE_REFERENCE_MIME_TYPES.has(mime)) {
      return reply.code(400).send({ error: "参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF" });
    }
    if (!(await isReadableRaster(bytes))) {
      return reply.code(400).send({ error: "参考图不是可读取的图片，或像素尺寸过大" });
    }

    const requestId = `ecom-reference:${randomUUID()}`;
    try {
      const stored = await storeWorkflowImage({
        image: { kind: "b64", b64: parsed.data.image.b64, mime },
        userId: req.userId,
        requestId,
        requestIndex: 0,
        fetchFn,
      });
      const asset = await prisma.imageAsset.create({
        data: {
          userId: req.userId,
          requestId,
          requestIndex: 0,
          prompt: "image_reference_upload",
          model: "image_reference_upload",
          size: "reference",
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
          objectKey: stored.objectKey,
          mime: stored.mime,
          width: stored.width ?? null,
          height: stored.height ?? null,
        },
      });
      return { success: true, data: { asset: serializeImageRow(asset) } };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "上传参考图失败" });
    }
  });
}
