import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_EMBEDDING_DIMENSION, validateEmbeddingVector } from "../memory/embedding-client.js";
import { EmptyTextError, PermanentDocumentError } from "./parse.js";

export { EmptyTextError } from "./parse.js";

class PermanentIndexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentIndexError";
  }
}

export interface IndexDeps {
  prisma: PrismaClient;
  loadObject: (doc: { sourceType: string; sourceUri: string | null }) => Promise<{
    buf: Buffer;
    mime: string;
    filename: string;
  }>;
  parse: (buf: Buffer, mime: string, filename: string) => Promise<string>;
  chunk: (text: string) => string[];
  embed: (input: string) => Promise<{ vector: number[]; tokens: number }>;
  embeddingDimension?: number;
  workerId: string;
  now?: () => Date;
}

export interface IndexOnceOptions {
  maxAttempts?: number;
  leaseMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_EMBED_CONCURRENCY = 4;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function envInteger(name: string, fallback: number): number {
  return positiveInteger(Number(process.env[name]), fallback);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
}

function upstreamStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
    const status = candidate.status ?? candidate.statusCode ?? candidate.$metadata?.httpStatusCode;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  const match = errorMessage(error).match(/^(?:HTTP|embeddings)\s+(\d{3})(?:\D|$)/i);
  return match ? Number(match[1]) : null;
}

function retryable(error: unknown): boolean {
  if (error instanceof PermanentIndexError || error instanceof PermanentDocumentError || error instanceof EmptyTextError) return false;
  if (error instanceof Error && ["EmptyTextError", "PermanentDocumentError", "SsrfError"].includes(error.name)) return false;
  const status = upstreamStatus(error);
  if (status !== null) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const message = errorMessage(error);
  return ![
    "不支持的文件类型：",
    "文件扩展名与 MIME 不匹配：",
    "Unknown sourceType:",
    "Document not found:",
    "Redirect target blocked:",
    "Too many redirects",
    "Response exceeds max size",
  ].some((prefix) => message.startsWith(prefix));
}

function vectorLiteral(vector: number[], dimension: number): string {
  try {
    return `[${validateEmbeddingVector(vector, dimension).join(",")}]`;
  } catch (cause) {
    throw new PermanentIndexError(errorMessage(cause), { cause });
  }
}

function fallbackTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text || " ", "utf8") / 3));
}

/** 兼容公开 API；indexOnce 传入唯一 attempt token，旧调用方传 workerId 也仍可抢占。 */
export async function claim(
  prisma: PrismaClient,
  docId: string,
  owner: string,
  leaseMs: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = new Date(),
): Promise<boolean> {
  const expiredBefore = new Date(now.getTime() - positiveInteger(leaseMs, DEFAULT_LEASE_MS));
  const rows = await prisma.$executeRaw<number>`
    UPDATE "Document"
    SET status = 'indexing', "lockedBy" = ${owner}, "lockedAt" = ${now}, attempts = attempts + 1
    WHERE id = ${docId}
      AND attempts < ${positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS)}
      AND (status = 'pending' OR (status = 'indexing' AND "lockedAt" < ${expiredBefore}))
  `;
  return rows === 1;
}

async function renewLease(prisma: PrismaClient, docId: string, owner: string, now: Date): Promise<boolean> {
  return (await prisma.document.updateMany({
    where: { id: docId, status: "indexing", lockedBy: owner },
    data: { lockedAt: now },
  })).count === 1;
}

function startHeartbeat(deps: IndexDeps, docId: string, owner: string, leaseMs: number) {
  let owned = true;
  let pending = Promise.resolve();
  const interval = Math.max(1, Math.floor(leaseMs / 3));
  const renew = async () => {
    if (!owned) return;
    try {
      owned = await renewLease(deps.prisma, docId, owner, deps.now?.() ?? new Date());
    } catch {
      // A transport hiccup is not proof that ownership was lost; publication re-checks the token under a row lock.
    }
  };
  const timer = setInterval(() => {
    pending = pending.then(renew);
  }, interval);
  timer.unref?.();
  return {
    isOwned: () => owned,
    stop: async () => {
      clearInterval(timer);
      await pending;
      return owned;
    },
  };
}

async function publish(
  deps: IndexDeps,
  doc: { id: string; kbId: string },
  owner: string,
  chunks: readonly string[],
  vectors: readonly string[],
  tokensUsed: number,
): Promise<boolean> {
  return deps.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Document"
      WHERE id = ${doc.id} AND status = 'indexing' AND "lockedBy" = ${owner}
      FOR UPDATE
    `;
    if (locked.length !== 1) return false;

    await tx.chunk.deleteMany({ where: { documentId: doc.id } });
    for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
      await tx.$executeRaw`
        INSERT INTO "Chunk" (id, "documentId", "kbId", ordinal, content, embedding, "createdAt")
        VALUES (${randomUUID()}, ${doc.id}, ${doc.kbId}, ${ordinal}, ${chunks[ordinal]}, ${vectors[ordinal]}::vector, now())
      `;
    }
    await tx.document.update({
      where: { id: doc.id, status: "indexing", lockedBy: owner },
      data: {
        status: "indexed",
        chunkCount: chunks.length,
        tokensUsed,
        lockedBy: null,
        lockedAt: null,
        error: null,
      },
    });
    return true;
  });
}

async function recordFailure(
  prisma: PrismaClient,
  docId: string,
  owner: string,
  error: unknown,
  maxAttempts: number,
): Promise<void> {
  const current = await prisma.document.findFirst({
    where: { id: docId, status: "indexing", lockedBy: owner },
    select: { attempts: true },
  });
  if (!current) return;
  const status = retryable(error) && current.attempts < maxAttempts ? "pending" : "failed";
  await prisma.document.updateMany({
    where: { id: docId, status: "indexing", lockedBy: owner },
    data: { status, error: errorMessage(error), lockedBy: null, lockedAt: null },
  });
}

/** 单次索引 attempt；attempt token 为每次抢占加 fencing，旧 worker 永远不能发布或改终态。 */
export async function indexOnce(deps: IndexDeps, docId: string, options: IndexOnceOptions = {}): Promise<void> {
  const maxAttempts = positiveInteger(options.maxAttempts, envInteger("KB_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS));
  const leaseMs = positiveInteger(options.leaseMs, envInteger("KB_INDEX_LEASE_MS", DEFAULT_LEASE_MS));
  const owner = `${deps.workerId}:${randomUUID()}`;
  const now = deps.now?.() ?? new Date();
  if (!(await claim(deps.prisma, docId, owner, leaseMs, maxAttempts, now))) return;

  const heartbeat = startHeartbeat(deps, docId, owner, leaseMs);
  try {
    const doc = await deps.prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw new PermanentIndexError(`Document not found: ${docId}`);
    const loaded = await deps.loadObject({ sourceType: doc.sourceType, sourceUri: doc.sourceUri });
    const text = await deps.parse(loaded.buf, loaded.mime, loaded.filename);
    const chunks = deps.chunk(text);
    if (chunks.length === 0) throw new PermanentIndexError("No chunks after splitting");

    const concurrency = envInteger("KB_EMBED_CONCURRENCY", DEFAULT_EMBED_CONCURRENCY);
    const embeds: Array<{ vector: number[]; tokens: number }> = [];
    let totalTokens = 0;
    for (let start = 0; start < chunks.length; start += concurrency) {
      if (!heartbeat.isOwned()) return;
      const batch = chunks.slice(start, start + concurrency);
      const results = await Promise.all(batch.map((chunk) => deps.embed(chunk)));
      embeds.push(...results);
      totalTokens += results.reduce((sum, result, index) => {
        const providerTokens = Number.isFinite(result.tokens) && result.tokens > 0 ? result.tokens : 0;
        return sum + Math.max(providerTokens, fallbackTokens(batch[index]));
      }, 0);
    }

    const dimension = deps.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION;
    const vectors = embeds.map(({ vector }) => vectorLiteral(vector, dimension));
    if (!(await heartbeat.stop())) return;
    await publish(deps, doc, owner, chunks, vectors, totalTokens);
  } catch (error) {
    await heartbeat.stop();
    await recordFailure(deps.prisma, docId, owner, error, maxAttempts);
  }
}
