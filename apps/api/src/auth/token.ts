import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signToken(userId: string, secret: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!userId || userId.includes(".")) throw new Error("用户 ID 不合法");
  const payload = `${userId}.${Math.trunc(Date.now() + ttlMs)}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyToken(token: string, secret: string): string | null {
  const [userId, expiresText, supplied, ...extra] = token.split(".");
  if (extra.length > 0 || !userId || !/^\d+$/.test(expiresText ?? "") || !supplied) return null;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return null;

  const actual = Buffer.from(supplied);
  const expected = Buffer.from(signature(`${userId}.${expiresText}`, secret));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return userId;
}
