import type { Prisma } from "@prisma/client";
import { visibleCharCount } from "./novel-billable.js";

// Content is read only to compute progress; large generation snapshots and raw
// drafts never leave the database for a compact project read.
export const novelChapterSummarySelect = {
  id: true,
  volumeIndex: true,
  chapterIndex: true,
  title: true,
  summary: true,
  content: true,
  status: true,
  reviewStatus: true,
  billableChars: true,
  tensionScore: true,
  qualityScore: true,
  lastTaskId: true,
  updatedAt: true,
} satisfies Prisma.NovelChapterSelect;

type SummaryRow = Prisma.NovelChapterGetPayload<{ select: typeof novelChapterSummarySelect }>;

export function serializeNovelChapterSummary(chapter: SummaryRow) {
  return {
    id: chapter.id,
    volumeIndex: chapter.volumeIndex,
    chapterIndex: chapter.chapterIndex,
    title: chapter.title,
    summary: chapter.summary,
    status: chapter.status,
    reviewStatus: chapter.reviewStatus,
    billableChars: chapter.billableChars,
    tensionScore: chapter.tensionScore,
    qualityScore: chapter.qualityScore,
    lastTaskId: chapter.lastTaskId,
    updatedAt: chapter.updatedAt.toISOString(),
    hasContent: Boolean(chapter.content?.trim()),
    wordCount: visibleCharCount(chapter.content ?? ""),
    // Explicit discriminator: an unloaded chapter must never enter the editor.
    detailLoaded: false as const,
  };
}

export const novelSetupChapterSelect = {
  id: true,
  volumeIndex: true,
  chapterIndex: true,
  title: true,
  summary: true,
  outline: true,
  generationHint: true,
  status: true,
  updatedAt: true,
} satisfies Prisma.NovelChapterSelect;
