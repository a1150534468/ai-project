import type { Prisma, PrismaClient } from "@prisma/client";
import { buildNovelGenerationContext } from "./novel-context-builder.js";
import type { NovelForeshadowPayload, NovelKnowledgeFactPayload } from "./novel-workbench-types.js";

type JsonValue = Prisma.JsonValue | null;

export type NovelChapterRow = {
  readonly id: string;
  readonly volumeIndex: number;
  readonly chapterIndex: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly rawContent?: string;
  readonly openThreads?: JsonValue;
  readonly contextSnapshot?: JsonValue;
  readonly generationMeta?: JsonValue;
  readonly consistencyJson?: JsonValue;
  readonly status: string;
  readonly reviewStatus?: string;
  readonly reviewNotes?: string;
  readonly aiReview?: string;
  readonly aiActionItems?: JsonValue;
  readonly modificationRate?: number;
  readonly reviewedAt?: Date | null;
  readonly billableChars: number;
  readonly lastTaskId: string | null;
  readonly updatedAt: Date;
};

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function serializeFact(fact: {
  readonly id: string;
  readonly chapterIndex: number | null;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly sourceExcerpt: string;
  readonly confidence: number;
  readonly status: string;
  readonly updatedAt: Date;
}): NovelKnowledgeFactPayload & { readonly updatedAt: string } {
  return {
    id: fact.id,
    chapterIndex: fact.chapterIndex,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    sourceExcerpt: fact.sourceExcerpt,
    confidence: fact.confidence,
    status: fact.status === "draft" || fact.status === "conflict" ? fact.status : "confirmed",
    updatedAt: fact.updatedAt.toISOString(),
  };
}

function serializeForeshadow(item: {
  readonly id: string;
  readonly introducedInChapterIndex: number | null;
  readonly title: string;
  readonly description: string;
  readonly expectedPayoffChapter: number;
  readonly status: string;
  readonly relatedCharacter: string;
  readonly updatedAt: Date;
}): NovelForeshadowPayload & { readonly updatedAt: string } {
  const status = item.status === "hinted" || item.status === "resolved" || item.status === "abandoned" ? item.status : "open";
  return {
    id: item.id,
    introducedInChapterIndex: item.introducedInChapterIndex,
    title: item.title,
    description: item.description,
    expectedPayoffChapter: item.expectedPayoffChapter,
    status,
    relatedCharacter: item.relatedCharacter,
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function serializeNovelWorkbenchChapter(chapter: NovelChapterRow) {
  return {
    id: chapter.id,
    volumeIndex: chapter.volumeIndex,
    chapterIndex: chapter.chapterIndex,
    title: chapter.title,
    summary: chapter.summary,
    content: chapter.content,
    rawContent: chapter.rawContent ?? "",
    openThreads: jsonStringArray(chapter.openThreads),
    contextSnapshot: chapter.contextSnapshot ?? null,
    generationMeta: chapter.generationMeta ?? null,
    consistencyJson: chapter.consistencyJson ?? null,
    status: chapter.status,
    reviewStatus: chapter.reviewStatus ?? "pending",
    reviewNotes: chapter.reviewNotes ?? "",
    aiReview: chapter.aiReview ?? "",
    aiActionItems: jsonStringArray(chapter.aiActionItems),
    modificationRate: chapter.modificationRate ?? 0,
    reviewedAt: chapter.reviewedAt?.toISOString() ?? null,
    billableChars: chapter.billableChars,
    lastTaskId: chapter.lastTaskId,
    updatedAt: chapter.updatedAt.toISOString(),
  };
}

export async function getNovelWorkbench(prisma: PrismaClient, userId: string, projectId: string) {
  const project = await prisma.novelProject.findFirst({ where: { id: projectId, userId } });
  if (!project) return null;
  const store = prisma as PrismaClient & {
    novelKnowledgeFact?: { findMany: (args: unknown) => Promise<ReturnType<typeof serializeFact>[]> };
    novelForeshadowItem?: { findMany: (args: unknown) => Promise<ReturnType<typeof serializeForeshadow>[]> };
  };
  const [sections, chapters, factRows, foreshadowRows] = await Promise.all([
    prisma.novelSection.findMany({ where: { projectId: project.id } }),
    prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } }),
    store.novelKnowledgeFact?.findMany({ where: { projectId: project.id }, orderBy: { updatedAt: "desc" }, take: 80 }) ?? Promise.resolve([]),
    store.novelForeshadowItem?.findMany({ where: { projectId: project.id }, orderBy: [{ status: "asc" }, { expectedPayoffChapter: "asc" }], take: 80 }) ?? Promise.resolve([]),
  ]);
  const serializedChapters = chapters.map((chapter) => serializeNovelWorkbenchChapter(chapter));
  const knowledgeFacts = factRows.map((fact) => serializeFact(fact as Parameters<typeof serializeFact>[0]));
  const foreshadowItems = foreshadowRows.map((item) => serializeForeshadow(item as Parameters<typeof serializeForeshadow>[0]));
  const totalWords = serializedChapters.reduce((sum, chapter) => sum + Array.from(chapter.content || "").filter((char) => /\S/u.test(char)).length, 0);
  const finishedChapters = serializedChapters.filter((chapter) => chapter.content.trim()).length;
  const focusChapterNumber = (serializedChapters.filter((chapter) => chapter.content.trim()).at(-1)?.chapterIndex ?? 0) + 1;
  const reviewFeedback = serializedChapters
    .filter((chapter) => chapter.chapterIndex < focusChapterNumber)
    .sort((a, b) => b.chapterIndex - a.chapterIndex)
    .slice(0, 5)
    .map((chapter) => ({
      chapterIndex: chapter.chapterIndex,
      status: chapter.reviewStatus,
      reviewNotes: chapter.reviewNotes,
      aiReview: chapter.aiReview,
      aiActionItems: chapter.aiActionItems,
      modificationRate: chapter.modificationRate,
    }));
  const context = buildNovelGenerationContext({
    project: { id: project.id, title: project.title, genre: project.genre },
    chapterIndex: focusChapterNumber,
    chapterTitle: `第 ${focusChapterNumber} 章`,
    chapterSummary: "",
    sections,
    previousChapters: serializedChapters,
    facts: knowledgeFacts,
    foreshadowItems,
    reviewFeedback,
  });
  const latestQuality = serializedChapters
    .map((chapter) => jsonRecord(chapter.consistencyJson))
    .filter((item): item is Record<string, unknown> => item !== null)
    .at(-1);
  const quality = jsonRecord(latestQuality?.quality);
  return {
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      status: project.status,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    stats: {
      totalWords,
      finishedChapters,
      completionRate: serializedChapters.length ? Math.round((finishedChapters / serializedChapters.length) * 100) : 0,
      averageWords: finishedChapters ? Math.round(totalWords / finishedChapters) : 0,
      lastUpdate: serializedChapters.at(-1)?.updatedAt ?? project.updatedAt.toISOString(),
    },
    chapters: serializedChapters,
    sections: sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      label: section.kind,
      status: section.status,
      displayText: section.displayText,
      billableChars: section.billableChars,
      lastTaskId: section.lastTaskId,
      updatedAt: section.updatedAt.toISOString(),
    })),
    knowledgeFacts,
    foreshadowItems,
    workbenchHighlights: {
      focusChapterNumber,
      recommendedFocus: context.focusCard.mission,
      dueForeshadowItems: foreshadowItems.filter((item) => item.status !== "resolved" && item.expectedPayoffChapter <= focusChapterNumber + 1),
      continuityAlerts: context.continuityAlerts,
      microBeats: context.microBeats,
      focusCard: context.focusCard,
      qualitySnapshot: {
        consistencyStatus: latestQuality?.status ?? "ok",
        consistencyRisks: Array.isArray(latestQuality?.risks) ? latestQuality.risks : [],
        styleRisk: quality?.styleRisk ?? "low",
        styleTone: "",
      },
      workflowGate: context.workflowGate,
    },
  };
}
