import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../storage/s3.js";

function trimTrailingSlash(v: string): string { return v.replace(/\/+$/u, ""); }
function encodeKey(key: string): string { return key.split("/").map(encodeURIComponent).join("/"); }

export function buildAudioPublicUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encoded = encodeKey(key);
  if (base) return `${trimTrailingSlash(base)}/${encoded}`;
  if (cfg.forcePathStyle) return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encoded}`;
  return `${trimTrailingSlash(cfg.endpoint).replace(/^(https?:\/\/)/u, `$1${cfg.bucket}.`)}/${encoded}`;
}

export async function storeAudioBuffer(args: { userId: string; buffer: Buffer; mime: string; ext: string; env?: NodeJS.ProcessEnv }): Promise<{ url: string; objectKey: string }> {
  const env = args.env ?? process.env;
  const cfg = loadS3Config(env);
  const s3 = makeS3(cfg);
  const key = `dub/audio/${args.userId}/${randomUUID()}.${args.ext}`;
  await putObject(s3, key, args.buffer, args.mime, { acl: "public-read" });
  return { url: buildAudioPublicUrl(cfg, key, env), objectKey: key };
}
