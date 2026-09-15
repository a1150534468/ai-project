import type { S3Config } from "./s3.js";

function encodedObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function appendPath(url: URL, suffix: string): string {
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${suffix}`;
  return url.toString();
}

export function publicObjectUrl(
  cfg: S3Config,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const encodedKey = encodedObjectKey(key);
  const publicBase = env.S3_PUBLIC_BASE_URL?.trim();
  if (publicBase) return appendPath(new URL(publicBase), encodedKey);

  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) {
    return appendPath(endpoint, `${encodeURIComponent(cfg.bucket)}/${encodedKey}`);
  }
  endpoint.hostname = `${cfg.bucket}.${endpoint.hostname}`;
  return appendPath(endpoint, encodedKey);
}
