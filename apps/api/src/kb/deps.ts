import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { getObject, putObject, type S3 } from "../storage/s3.js";
import { fetchUrl, assertSafeUrl } from "./url-fetch.js";
import { parseDocument } from "./parse.js";
import { chunkText } from "./chunk.js";
import { embed, loadEmbeddingConfig } from "../memory/embedding-client.js";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { IndexDeps } from "./indexer.js";

/**
 * 构建索引依赖（工厂函数）
 * 装配真实的 S3/fetchUrl/parse/chunk/embed/billing 实现
 * 供 routes 与后续 reaper/indexer 复用
 */
export async function buildIndexDeps(
  s3: S3
): Promise<IndexDeps> {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const embCfg = loadEmbeddingConfig();

  return {
    prisma,
    loadObject: async (doc) => {
      if (doc.sourceType === "FILE" || doc.sourceType === "TEXT") {
        // FILE 和 TEXT 都存在 S3，sourceUri 是 S3 key
        const buf = await getObject(s3, doc.sourceUri!);
        const filename = doc.sourceUri!.split("/").pop() ?? "document";
        const mime = doc.sourceType === "TEXT" ? "text/plain" : "application/octet-stream";
        return { buf, mime, filename };
      } else if (doc.sourceType === "URL") {
        // URL：fetch 抓取
        const result = await fetchUrl(doc.sourceUri!, {
          maxBytes: parseInt(process.env.KB_URL_MAX_BYTES ?? "10485760", 10),
          timeoutMs: parseInt(process.env.KB_URL_FETCH_TIMEOUT_MS ?? "15000", 10),
          maxRedirects: parseInt(process.env.KB_URL_MAX_REDIRECTS ?? "3", 10),
        });
        const filename = new URL(result.finalUrl).pathname.split("/").pop() ?? "document";
        return { buf: result.buf, mime: result.contentType, filename };
      }
      throw new Error(`Unknown sourceType: ${doc.sourceType}`);
    },
    parse: parseDocument,
    chunk: (text) =>
      chunkText(text, {
        maxTokens: parseInt(process.env.KB_CHUNK_TOKENS ?? "800", 10),
        overlapTokens: parseInt(process.env.KB_CHUNK_OVERLAP ?? "100", 10),
        maxChunks: parseInt(process.env.KB_MAX_CHUNKS ?? "2000", 10),
      }),
    embed: async (input) => embed(embCfg, input),
    billing: {
      settle: (arg) => billing.settle(arg),
    },
    embeddingModel: embCfg.model,
    workerId: `${process.pid}-${os.hostname()}-${randomUUID()}`,
  };
}
