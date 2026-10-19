import { resolveKey } from "./s3-key.js";
import type { S3Config } from "./s3-types.js";

function encodedObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function appendPath(url: URL, suffix: string): string {
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${suffix}`;
  return url.toString();
}

export function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv = process.env): string {
  // The environment folder is part of the physical path, so the public URL has
  // to carry it too. Without this every `dev/...` object would be requested as
  // `/workflow/...` and 404 against the bucket root.
  const encodedKey = encodedObjectKey(resolveKey(cfg, key));
  const publicBase = env.S3_PUBLIC_BASE_URL?.trim();
  if (publicBase) return appendPath(new URL(publicBase), encodedKey);

  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) {
    return appendPath(endpoint, `${encodeURIComponent(cfg.bucket)}/${encodedKey}`);
  }
  endpoint.hostname = `${cfg.bucket}.${endpoint.hostname}`;
  return appendPath(endpoint, encodedKey);
}
