/**
 * image-service 拆分后的落盘层：对象键校验、公网 URL 拼装、远端图片抓取、量宽高、入库。
 *
 * 本文件里的 `publicObjectUrl` 与 `../../storage/public-url.js` 的同名导出**不是**一回事，
 * 拆分前就用 `basePublicObjectUrl` 这个别名区分，别把两者合并。
 *
 * 依赖方向：constants / types / upstream → 本文件。不 import providers / calls。
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../../storage/s3.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import { publicObjectUrl as basePublicObjectUrl } from "../../storage/public-url.js";
import { DEFAULT_IMAGE_MAX_BYTES, GPT_IMAGE_MAX_PIXELS } from "./image-service-constants.js";
import { fetchWithSignal, withImageAttemptDeadline } from "./image-service-upstream.js";
import type { FetchLike, StoredImage, StoreWorkflowImageArgs } from "./image-service-types.js";

/** Validate a persisted workflow-image key before a worker or route reads S3. */
export function isVerifiedWorkflowImageObjectKey(value: string): boolean {
  const key = value.trim();
  if (key !== value || !key.startsWith("workflow/") || key.includes("\\")) return false;
  if ([...key].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  const segments = key.split("/");
  return segments.length >= 4
    && !key.endsWith("/")
    && !segments.some((segment) => !segment || segment === "." || segment === "..");
}

export function isVerifiedWorkflowImageObjectKeyForUser(value: string, userId: string): boolean {
  if (!isVerifiedWorkflowImageObjectKey(value) || !userId.trim()) return false;
  const segments = value.split("/");
  return segments[0] === "workflow"
    && (segments[1] === "images" || segments[1] === "codex-pets")
    && segments[2] === userId;
}

export function publicBaseFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.IMAGE_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
}

export function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv): string {
  const imageBase = (env.IMAGE_S3_PUBLIC_BASE_URL ?? "").trim();
  return basePublicObjectUrl(cfg, key, imageBase ? { ...env, S3_PUBLIC_BASE_URL: imageBase } : env);
}

export function dataUrlForBinary(binary: { readonly buffer: Buffer; readonly mime: string }): string {
  return `data:${binary.mime};base64,${binary.buffer.toString("base64")}`;
}

export function shouldInlineStoredImageForLocalEndpoint(cfg: S3Config, env: NodeJS.ProcessEnv): boolean {
  if (publicBaseFromEnv(env)) return false;
  try {
    const endpoint = new URL(cfg.endpoint);
    return ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  } catch {
    return false;
  }
}

export function tryLoadS3(env: NodeJS.ProcessEnv): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

export async function fetchRemoteImage(
  url: string,
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly mime: string }> {
  // 下载同样把 body 读取纳入 deadline：卡在下行的连接不该无上限地占着批次。
  return await withImageAttemptDeadline(60_000, signal, async (deadlineSignal) => {
    const response = await fetchWithSignal(fetchFn, url, { method: "GET" }, deadlineSignal);
    if (!response.ok) throw new Error(`image download ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const maxBytes = Number(env.IMAGE_MAX_BYTES) || DEFAULT_IMAGE_MAX_BYTES;
    if (buffer.byteLength > maxBytes) throw new Error("image too large");
    const contentType = response.headers.get("content-type") ?? "image/png";
    return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
  });
}

/** 量一下真实宽高，量不出来就当没有——上游返回损坏数据不该拦住入库。 */
export async function measureBinary(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(buffer, { limitInputPixels: GPT_IMAGE_MAX_PIXELS }).metadata();
    return { width: metadata.width ?? null, height: metadata.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

export async function storeWorkflowImage(args: StoreWorkflowImageArgs): Promise<StoredImage> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  if (args.acl === "private" && !loaded) {
    throw new Error("private workflow image storage requires S3 configuration");
  }
  if (args.image.kind === "url" && !loaded) {
    return { originalUrl: args.image.url, thumbnailUrl: args.image.url, mime: "image/png", objectKey: null };
  }
  const binary = args.image.kind === "b64"
    ? { buffer: Buffer.from(args.image.b64, "base64"), mime: args.image.mime }
    : await fetchRemoteImage(args.image.url, args.fetchFn, env, args.signal);
  const measured = await measureBinary(binary.buffer);
  if (!loaded) {
    const dataUrl = dataUrlForBinary(binary);
    return { originalUrl: dataUrl, thumbnailUrl: dataUrl, mime: binary.mime, objectKey: null, ...measured };
  }
  const extension = binary.mime.includes("webp")
    ? "webp"
    : binary.mime.includes("jpeg") || binary.mime.includes("jpg")
      ? "jpg"
      : "png";
  const namespace = args.namespace?.trim().replace(/^\/+|\/+$/g, "") || "workflow/images";
  if (!/^[A-Za-z0-9._/-]+$/.test(namespace) || namespace.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("workflow image namespace is invalid");
  }
  const key = `${namespace}/${args.userId}/${args.requestId}/${args.requestIndex}-${randomUUID()}.${extension}`;
  await putObject(loaded.s3, key, binary.buffer, binary.mime, args.acl === "private" ? {} : { acl: "public-read" });
  const url = args.acl === "private"
    ? ""
    : shouldInlineStoredImageForLocalEndpoint(loaded.cfg, env)
    ? dataUrlForBinary(binary)
    : publicObjectUrl(loaded.cfg, key, env);
  return { originalUrl: url, thumbnailUrl: url, mime: binary.mime, objectKey: key, ...measured };
}
