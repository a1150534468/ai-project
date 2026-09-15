import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { apiDocsEnabled, registerOpenApi } from "./docs/openapi.js";

const DEFAULT_BODY_LIMIT = 30 * 1024 * 1024;
const DEFAULT_UPLOAD_LIMIT = 20 * 1024 * 1024;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function apiBodyLimit(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.API_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT);
}

export async function registerServerFoundation(app: FastifyInstance): Promise<boolean> {
  const docsEnabled = apiDocsEnabled();
  if (docsEnabled) await registerOpenApi(app);

  const configuredOrigins = process.env.CORS_ORIGIN
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: configuredOrigins?.length ? configuredOrigins : true,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: positiveNumber(process.env.KB_MAX_FILE_BYTES, DEFAULT_UPLOAD_LIMIT) },
  });
  return docsEnabled;
}
