import { createHmac, timingSafeEqual } from "node:crypto";

// admin token: admin.<adminId>.<expMs>.<sig>（独立 secret + admin. 前缀，防与用户 token 混用）
export function signAdminToken(
  adminId: string,
  secret: string,
  ttlMs = 12 * 3600_000
): string {
  const exp = String(Date.now() + ttlMs);
  const payload = `admin.${adminId}.${exp}`;
  const sig = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdminToken(
  token: string,
  secret: string
): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "admin") return null;
  const [, adminId, exp, sig] = parts;
  const expected = createHmac("sha256", secret)
    .update(`admin.${adminId}.${exp}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return adminId;
}
