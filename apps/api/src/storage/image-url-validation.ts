import type { SignedImageRequest } from "./cos-image-url.js";

export function validateSignedImageRequest({
  objectKey,
  mime,
  contentDisposition,
  expiresAt,
}: SignedImageRequest): void {
  // URL parsers normalize dot segments; never authorize a different object than the caller checked.
  if (
    !objectKey ||
    /[\\\x00-\x1f\x7f]/.test(objectKey) ||
    objectKey.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid image object key");
  if (!/^image\/[a-zA-Z0-9.+-]+(?: *;.*)?$/.test(mime) || /[\x00-\x1f\x7f]/.test(mime + (contentDisposition ?? ""))) {
    throw new Error("Invalid image response headers");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt - Date.now() < 2_000) throw new Error("Image URL has expired");
}
