import type { FastifyInstance } from "fastify";
import { verifyToken } from "./auth/token.js";

export function readCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const field of header.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 1 || field.slice(0, separator).trim() !== name) continue;
    const value = field.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function installRequestAuthentication(app: FastifyInstance, secret: string): void {
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : readCookieValue(request.headers.cookie, "token");
    if (!token) return;
    const userId = verifyToken(token, secret);
    if (userId) request.userId = userId;
  });
}
