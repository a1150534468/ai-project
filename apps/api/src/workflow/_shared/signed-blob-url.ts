import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 签名 blob URL 的共享实现。此前同一套「HMAC-SHA256 签名 + 先比长度再
 * timingSafeEqual」在 7 处各写一份、各自演进；收敛后签名原语只有这一处。
 *
 * 各域的电文格式**逐字保留**，差异通过 config / payload 注入表达，不做统一：
 *  - try-on / nail-try-on / portrait：payload `${kind}:${id}:${objectKey}:${exp}`、
 *    hex、exp 为秒 —— 走下面的 createSignedBlobUrl / verifySignedBlobUrl；
 *  - image / article / codex-pet：payload 是各自的 `\n` 拼串、base64url、exp 为毫秒
 *    —— 只共用 signPayload / verifyPayloadSignature 两个原语。
 */

export type SignatureEncoding = "hex" | "base64url";

/** 对 payload 做 HMAC-SHA256 签名，按域既有编码输出。 */
export function signPayload(secret: string, payload: string, encoding: SignatureEncoding): string {
  return createHmac("sha256", secret).update(payload).digest(encoding);
}

/**
 * 校验签名：先比长度再 timingSafeEqual —— 长度不等时 timingSafeEqual 会抛，
 * 必须先挡；长度不等直接判否，不抛异常。
 */
export function verifyPayloadSignature(
  secret: string,
  payload: string,
  signature: string,
  encoding: SignatureEncoding,
): boolean {
  const expected = Buffer.from(signPayload(secret, payload, encoding));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type SignedBlobKind = "reference" | "output";

/**
 * 冒号族（try-on / nail-try-on / portrait）的域配置。
 * `resolveSecret` 由各域提供：secret 的 fallback 链是各域自己的策略
 * （如 try-on 的 TRY_ON → PORTRAIT → SESSION），原样保留在各域文件里。
 * `buildPath` 给出不带 query 的路径（kind→路径段的映射各域不同）。
 */
export interface SignedBlobUrlConfig {
  readonly resolveSecret: (env?: NodeJS.ProcessEnv) => string;
  readonly ttlMs: number;
  readonly buildPath: (kind: SignedBlobKind, id: string) => string;
}

function colonPayload(kind: SignedBlobKind, id: string, objectKey: string, exp: number): string {
  return `${kind}:${id}:${objectKey}:${exp}`;
}

/** 签发：exp 为秒级 epoch（冒号族既有口径），签名 hex。 */
export function createSignedBlobUrl(
  config: SignedBlobUrlConfig,
  args: { readonly kind: SignedBlobKind; readonly id: string; readonly objectKey: string },
  env?: NodeJS.ProcessEnv,
): string {
  const exp = Math.floor((Date.now() + config.ttlMs) / 1000);
  const sig = signPayload(
    config.resolveSecret(env),
    colonPayload(args.kind, args.id, args.objectKey, exp),
    "hex",
  );
  return `${config.buildPath(args.kind, args.id)}?exp=${exp}&sig=${sig}`;
}

/** 校验：过期先判，再走共享的签名校验。 */
export function verifySignedBlobUrl(
  config: SignedBlobUrlConfig,
  args: {
    readonly kind: SignedBlobKind;
    readonly id: string;
    readonly objectKey: string;
    readonly exp: number;
    readonly sig: string;
  },
  env?: NodeJS.ProcessEnv,
): boolean {
  if (args.exp < Math.floor(Date.now() / 1000)) return false;
  return verifyPayloadSignature(
    config.resolveSecret(env),
    colonPayload(args.kind, args.id, args.objectKey, args.exp),
    args.sig,
    "hex",
  );
}
