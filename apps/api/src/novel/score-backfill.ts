import type { Prisma, PrismaClient } from "@prisma/client";
import { evaluateNovelQualityGate } from "@ai-assistant/novel-workflow";
import { buildNovelQualityDiagnostics } from "../workflow/novel/index.js";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function recalculateNovelChapterScores(args: { readonly prisma: PrismaClient; readonly projectId: string }): Promise<{ rescoredChapters: number }> {
  const [project, chapters] = await Promise.all([
    args.prisma.novelProject.findUniqueOrThrow({ where: { id: args.projectId }, select: { targetCharsPerChapter: true } }),
    args.prisma.novelChapter.findMany({ where: { projectId: args.projectId, content: { not: "" } }, orderBy: { chapterIndex: "asc" } }),
  ]);
  for (const chapter of chapters) {
    const quality = buildNovelQualityDiagnostics(chapter.content);
    const consistency = record(chapter.consistencyJson);
    const risks = Array.isArray(consistency.risks) ? consistency.risks : [];
    const styleScore = quality.styleRisk === "low" ? 0.9 : quality.styleRisk === "medium" ? 0.7 : 0.45;
    const gate = evaluateNovelQualityGate({
      consistencyScore: risks.length === 0 ? 0.9 : Math.max(0.4, 0.9 - risks.length * 0.1),
      styleScore,
      tensionScore: quality.tensionScore / 100,
      highSeverityIssues: quality.issues.filter((issue) => issue.severity === "high").length,
      criticalIssues: 0,
      contentChars: chapter.billableChars || Array.from(chapter.content).filter((char) => /\S/u.test(char)).length,
      targetChars: project.targetCharsPerChapter,
    });
    await args.prisma.$transaction([
      args.prisma.novelQualityReport.deleteMany({ where: { projectId: args.projectId, chapterNumber: chapter.chapterIndex, runId: null } }),
      args.prisma.novelChapter.update({
        where: { id: chapter.id },
        data: {
          tensionScore: quality.tensionScore,
          plotTension: quality.tensionDimensions.plot,
          emotionalTension: quality.tensionDimensions.emotional,
          pacingTension: quality.tensionDimensions.pacing,
          qualityScore: gate.score,
          generationMeta: { ...record(chapter.generationMeta), tensionScoringVersion: quality.tensionDimensions.scoringVersion } as Prisma.InputJsonValue,
          consistencyJson: { ...consistency, quality } as unknown as Prisma.InputJsonValue,
        },
      }),
      args.prisma.novelQualityReport.create({
        data: {
          projectId: args.projectId,
          chapterId: chapter.id,
          chapterNumber: chapter.chapterIndex,
          overallScore: gate.score,
          consistencyScore: risks.length === 0 ? 90 : Math.max(40, 90 - risks.length * 10),
          styleScore: styleScore * 100,
          tensionScore: quality.tensionScore,
          issues: quality.issues as unknown as Prisma.InputJsonValue,
          metrics: { ...quality.metrics, tensionDimensions: quality.tensionDimensions } as Prisma.InputJsonValue,
          gatePassed: gate.passed,
        },
      }),
    ]);
  }
  return { rescoredChapters: chapters.length };
}
