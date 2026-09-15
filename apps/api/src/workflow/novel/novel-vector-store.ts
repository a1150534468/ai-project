import { randomUUID } from "node:crypto";
import type {
  ExistingNovelVector,
  NovelVectorDocument,
  NovelVectorHit,
  NovelVectorStore,
} from "./novel-vector-types.js";

const MAX_VECTOR_HITS = 8;

function pgVector(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export async function readExistingNovelVectors(
  store: NovelVectorStore,
  projectId: string,
): Promise<ExistingNovelVector[]> {
  return store.$queryRawUnsafe<ExistingNovelVector[]>(
    `SELECT id, "sourceType", "sourceId", "contentHash"
     FROM "NovelVectorMemory"
     WHERE "projectId" = $1`,
    projectId,
  );
}

export async function deleteNovelVectors(
  store: NovelVectorStore,
  projectId: string,
  rowIds: readonly string[],
): Promise<void> {
  if (rowIds.length === 0) return;
  const placeholders = rowIds.map((_, index) => `$${index + 2}`).join(", ");
  await store.$executeRawUnsafe(
    `DELETE FROM "NovelVectorMemory" WHERE "projectId" = $1 AND id IN (${placeholders})`,
    projectId,
    ...rowIds,
  );
}

export async function writeNovelVector(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly document: NovelVectorDocument;
  readonly vector: readonly number[];
}): Promise<void> {
  const { document } = args;
  await args.store.$executeRawUnsafe(
    `INSERT INTO "NovelVectorMemory"(
      id, "projectId", "sourceType", "sourceId", "sourceKind", title, content, "contentHash", embedding, "createdAt", "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, now(), now())
    ON CONFLICT ("projectId", "sourceType", "sourceId") DO UPDATE SET
      "sourceKind" = EXCLUDED."sourceKind",
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      "contentHash" = EXCLUDED."contentHash",
      embedding = EXCLUDED.embedding,
      "updatedAt" = now()`,
    randomUUID(),
    args.projectId,
    document.sourceType,
    document.sourceId,
    document.sourceKind,
    document.title,
    document.content,
    document.contentHash,
    pgVector(args.vector),
  );
}

export async function findNearestNovelVectors(args: {
  readonly store: NovelVectorStore;
  readonly projectId: string;
  readonly vector: readonly number[];
  readonly excludedSourceKind?: string;
  readonly limit?: number;
}): Promise<NovelVectorHit[]> {
  const limit = Math.max(1, Math.min(args.limit ?? MAX_VECTOR_HITS, MAX_VECTOR_HITS));
  const rows = await args.store.$queryRawUnsafe<NovelVectorHit[]>(
    `SELECT id, "sourceType", "sourceId", "sourceKind", title, content,
            1 - (embedding <=> $1::vector) AS score
     FROM "NovelVectorMemory"
     WHERE "projectId" = $2
       AND "sourceKind" <> $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    pgVector(args.vector),
    args.projectId,
    args.excludedSourceKind ?? "",
    limit,
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}
