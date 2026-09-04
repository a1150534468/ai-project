import { getPrisma } from "@ai-assistant/db";
import { getObject, type S3 } from "../storage/s3.js";
import { fetchUrl } from "./url-fetch.js";
import { parseDocument } from "./parse.js";
import { chunkText } from "./chunk.js";
import { embed, loadEmbeddingConfig } from "../memory/embedding-client.js";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { IndexDeps } from "./indexer.js";

/**
 * 构建索引依赖（工厂函数）
 * 装配真实的 S3/fetchUrl/parse/chunk/embed 实现
 * 供 routes 与后续 reaper/indexer 复用
 */
export async function buildIndexDeps(
  s3: S3
): Promise<IndexDeps> {
  const prisma = getPrisma();
  const embCfg = loadEmbeddingConfig();

  return {
    prisma,
    loadObject: async (doc) => {
      // P5.2 之前这里的第一个分支是 `sourceType === "ARTIFACT"`，把内联在
      // `Document.content` 的产物正文直接包成 Buffer。P1.2 之后没有产物文档，这个
      // 分支已不可达；`content` 列随 P5.2 删掉后它连编译都过不去，所以一并退役
      // （计划把它挂在 P5.3 名下，实际由本项带走）。剩下三种来源都靠 sourceUri 定位。
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
    embeddingDimension: embCfg.dimension,
    workerId: `${process.pid}-${os.hostname()}-${randomUUID()}`,
  };
}
