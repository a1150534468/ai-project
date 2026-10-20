import type { Buffer } from "node:buffer";
import type { FastifyReply } from "fastify";
import type { ImageUrlSigner, SignedImageRequest } from "../../storage/cos-image-url.js";

/**
 * 回源留痕的默认实现：只在「开了直连却签不出来」时告警。
 * `delivery-disabled`（proxy 模式）是预期行为，不告警——否则每个环境每条请求都在刷日志。
 */
export function logUnsignedFallback(
  log: { readonly warn: (obj: unknown, msg: string) => void },
  scope: string,
): (reason: "delivery-disabled" | "unsupported-asset", image: SignedImageRequest) => void {
  return (reason, image) => {
    if (reason === "delivery-disabled") return;
    log.warn({ scope, objectKey: image.objectKey, mime: image.mime }, `${scope} 图片无法签发直连 URL，回源读取（CDN 可能白配）`);
  };
}

/** Call only after verifying the application signature and resource access. */
export async function sendImageBlob(
  reply: FastifyReply,
  image: SignedImageRequest,
  deps: {
    readonly signImageUrl: ImageUrlSigner;
    readonly loadStoredImage: (objectKey: string) => Promise<Buffer>;
    /**
     * 回源时被调用一次。`delivery-disabled` 是预期行为（debug 级就够），
     * `unsupported-asset` 是退化——配了 CDN 却签不出来，说明 CDN 白配了，必须可观测。
     */
    readonly onUnsigned?: (reason: "delivery-disabled" | "unsupported-asset", image: SignedImageRequest) => void;
  },
): Promise<FastifyReply> {
  const result = await deps.signImageUrl(image);
  if (result.kind === "signed") {
    return reply
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .redirect(result.url, 302);
  }

  deps.onUnsigned?.(result.reason, image);
  const bytes = await deps.loadStoredImage(image.objectKey);
  reply.header("Cache-Control", "private, max-age=300").type(image.mime);
  if (image.contentDisposition) reply.header("Content-Disposition", image.contentDisposition);
  return reply.send(bytes);
}
