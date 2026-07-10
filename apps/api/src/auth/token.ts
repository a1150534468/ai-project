import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// token 结构: <userId>.<expMs>.<hmac>
export function signToken(userId: string, secret: string, ttlMs = 7 * 24 * 3600_000): string {
  const exp = String(Date.now() + ttlMs);
  const payload = `${userId}.${exp}`;
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${userId}.${exp}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return userId;
}
