import type { PrismaClient } from "@prisma/client";

export type NovelVectorStore = {
  readonly novelProject: Pick<PrismaClient["novelProject"], "findUnique">;
  readonly novelBible: Pick<PrismaClient["novelBible"], "findUnique">;
  readonly novelWorldDimension: Pick<PrismaClient["novelWorldDimension"], "findMany">;
  readonly novelStyleNote: Pick<PrismaClient["novelStyleNote"], "findMany">;
  readonly novelCharacter: Pick<PrismaClient["novelCharacter"], "findMany">;
  readonly novelLocation: Pick<PrismaClient["novelLocation"], "findMany">;
  readonly novelStoryline: Pick<PrismaClient["novelStoryline"], "findMany">;
  readonly novelChapter: Pick<PrismaClient["novelChapter"], "findMany">;
  $queryRawUnsafe<T = unknown>(query: string, ...values: readonly unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
};

export type NovelVectorSource =
  | "bible"
  | "world"
  | "style"
  | "character"
  | "location"
  | "storyline"
  | "chapter";

export interface NovelVectorDocument {
  readonly sourceType: NovelVectorSource;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface ExistingNovelVector {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly contentHash: string;
}

export interface NovelVectorHit {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly title: string;
  readonly content: string;
  readonly score: number;
}

export function novelVectorIdentity(row: Pick<ExistingNovelVector, "sourceType" | "sourceId">): string {
  return `${row.sourceType}:${row.sourceId}`;
}
