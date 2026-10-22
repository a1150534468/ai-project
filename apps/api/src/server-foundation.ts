import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { apiDocsEnabled, registerOpenApi } from "./docs/openapi.js";
import { envInt } from "./runtime/env.js";

const DEFAULT_BODY_LIMIT = 30 * 1024 * 1024;
const DEFAULT_UPLOAD_LIMIT = 20 * 1024 * 1024;

export function apiBodyLimit(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "API_BODY_LIMIT_BYTES", DEFAULT_BODY_LIMIT);
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
    limits: { fileSize: envInt(process.env, "KB_MAX_FILE_BYTES", DEFAULT_UPLOAD_LIMIT) },
  });
  return docsEnabled;
}
