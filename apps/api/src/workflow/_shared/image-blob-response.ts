import type { Buffer } from "node:buffer";
import type { FastifyReply } from "fastify";
import type { ImageUrlSigner, SignedImageRequest } from "../../storage/cos-image-url.js";

/** Call only after verifying the application signature and resource access. */
export async function sendImageBlob(
  reply: FastifyReply,
  image: SignedImageRequest,
  deps: {
    readonly signImageUrl: ImageUrlSigner;
    readonly loadStoredImage: (objectKey: string) => Promise<Buffer>;
  },
): Promise<FastifyReply> {
  const url = await deps.signImageUrl(image);
  if (url) {
    return reply
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .redirect(url, 302);
  }

  const bytes = await deps.loadStoredImage(image.objectKey);
  reply.header("Cache-Control", "private, max-age=300").type(image.mime);
  if (image.contentDisposition) reply.header("Content-Disposition", image.contentDisposition);
  return reply.send(bytes);
}
