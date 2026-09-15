import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "admin";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signAdminToken(adminId: string, secret: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!adminId || adminId.includes(".")) throw new Error("管理员 ID 不合法");
  const payload = `${TOKEN_PREFIX}.${adminId}.${Math.trunc(Date.now() + ttlMs)}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyAdminToken(token: string, secret: string): string | null {
  const [prefix, adminId, expiresText, supplied, ...extra] = token.split(".");
  if (extra.length > 0 || prefix !== TOKEN_PREFIX || !adminId || !/^\d+$/.test(expiresText ?? "")) {
    return null;
  }
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !supplied) return null;

  const payload = `${TOKEN_PREFIX}.${adminId}.${expiresText}`;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(signature(payload, secret));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return adminId;
}
