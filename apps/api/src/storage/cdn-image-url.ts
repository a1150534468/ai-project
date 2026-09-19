import { createHash } from "node:crypto";
import type { ImageUrlSigner } from "./cos-image-url.js";
import { validateSignedImageRequest } from "./image-url-validation.js";

// Must match Tencent CDN: TypeD / SHA256 / dec / sign / t / all files / 300 seconds.
export const CDN_IMAGE_AUTH_TTL_SECONDS = 300;

export function createCdnImageUrlSigner(env: NodeJS.ProcessEnv): ImageUrlSigner {
  let base: URL;
  try {
    base = new URL(env.WORKFLOW_IMAGE_CDN_BASE_URL?.trim() ?? "");
  } catch {
    throw new Error("WORKFLOW_IMAGE_CDN_BASE_URL must be an HTTPS domain without a path");
  }
  if (
    base.protocol !== "https:" ||
    base.port ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(base.hostname)
  )
    throw new Error("WORKFLOW_IMAGE_CDN_BASE_URL must be an HTTPS domain without a path");
  const key = env.WORKFLOW_IMAGE_CDN_SIGNING_KEY ?? "";
  if (!/^[A-Za-z0-9]{6,32}$/.test(key)) {
    throw new Error("WORKFLOW_IMAGE_CDN_SIGNING_KEY must contain 6-32 alphanumeric characters");
  }

  return async (image) => {
    validateSignedImageRequest(image);
    // Sign the exact percent-encoded request path (verified against Tencent for pet names).
    // Keep reserved characters, percent escapes and invalid Unicode on the proxy path;
    // never normalize or decode stored keys, which could change object identity.
    // Non-raster types also keep the existing proxy response headers and handling.
    if (
      !/^[\p{L}\p{N}\p{M}_./~ ·-]+$/u.test(image.objectKey) ||
      !/^image\/(?:png|jpeg|webp|gif|avif|bmp)(?: *;.*)?$/i.test(image.mime) ||
      (image.contentDisposition && !/^inline(?:;|$)/.test(image.contentDisposition))
    )
      return null;

    const now = Math.floor(Date.now() / 1_000);
    // TypeD expires at t + console TTL, not at t. Backdate t to cap short application grants.
    // Leave one second of slack because the edge may accept equality at its expiry boundary.
    const end = Math.min(now + CDN_IMAGE_AUTH_TTL_SECONDS, Math.floor(image.expiresAt / 1_000)) - 1;
    const timestamp = String(end - CDN_IMAGE_AUTH_TTL_SECONDS);
    const path = `/${image.objectKey.split("/").map(encodeURIComponent).join("/")}`;
    const signature = createHash("sha256").update(`${key}${path}${timestamp}`).digest("hex");
    const url = new URL(path, base.origin);
    url.searchParams.set("sign", signature);
    url.searchParams.set("t", timestamp);
    // TypeD does not sign arbitrary query parameters. Rely on stored COS Content-Type;
    // do not attach unsigned response overrides or image-processing parameters.
    return url.href;
  };
}
