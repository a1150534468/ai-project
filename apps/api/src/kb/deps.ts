import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getPrisma } from "@ai-assistant/db";
import { embed, loadEmbeddingConfig } from "../memory/embedding-client.js";
import { getObject, type S3 } from "../storage/s3.js";
import { chunkText } from "./chunk.js";
import type { IndexDeps } from "./indexer.js";
import { parseDocument } from "./parse.js";
import { fetchUrl } from "./url-fetch.js";

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function filenameFromLocation(location: string): string {
  return location.split("/").pop() || "document";
}

/**
 * 这一层只装配索引器的真实依赖，不承载重试或入库策略。
 * FILE/TEXT 都以 sourceUri 作为 S3 key；URL 才走受 SSRF 防护的 fetchUrl。
 */
export async function buildIndexDeps(s3: S3): Promise<IndexDeps> {
  const embedding = loadEmbeddingConfig();
  return {
    prisma: getPrisma(),
    loadObject: async (document) => {
      const location = document.sourceUri;
      if (document.sourceType === "FILE" || document.sourceType === "TEXT") {
        const buf = await getObject(s3, location!);
        return {
          buf,
          mime: document.sourceType === "TEXT" ? "text/plain" : "application/octet-stream",
          filename: filenameFromLocation(location!),
        };
      }
      if (document.sourceType === "URL") {
        const fetched = await fetchUrl(location!, {
          maxBytes: integerSetting(process.env, "KB_URL_MAX_BYTES", 10_485_760),
          timeoutMs: integerSetting(process.env, "KB_URL_FETCH_TIMEOUT_MS", 15_000),
          maxRedirects: integerSetting(process.env, "KB_URL_MAX_REDIRECTS", 3),
        });
        return {
          buf: fetched.buf,
          mime: fetched.contentType,
          filename: filenameFromLocation(new URL(fetched.finalUrl).pathname),
        };
      }
      throw new Error(`Unknown sourceType: ${document.sourceType}`);
    },
    parse: parseDocument,
    chunk: (text) => chunkText(text, {
      maxTokens: integerSetting(process.env, "KB_CHUNK_TOKENS", 800),
      overlapTokens: integerSetting(process.env, "KB_CHUNK_OVERLAP", 100),
      maxChunks: integerSetting(process.env, "KB_MAX_CHUNKS", 2_000),
    }),
    embed: (input) => embed(embedding, input),
    embeddingDimension: embedding.dimension,
    workerId: `${process.pid}-${hostname()}-${randomUUID()}`,
  };
}
