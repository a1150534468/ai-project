import type { S3Config } from "./s3.js";
import { trimTrailingSlash } from "../runtime/url.js";

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function publicObjectUrl(
  cfg: S3Config,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredBase = (env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encodedKey = encodeObjectKey(key);
  if (configuredBase) return `${trimTrailingSlash(configuredBase)}/${encodedKey}`;
  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) {
    return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  }
  return `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`;
}
