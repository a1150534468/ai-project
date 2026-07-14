import { Prisma, type PrismaClient } from "@prisma/client";
import { getRedis } from "@ai-assistant/db";
import type { NovelEventType, NovelPipelineStepKind, NovelRunStatus } from "@ai-assistant/novel-workflow/contracts";

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function novelRunChannel(runId: string): string {
  return `novel:run:${runId}`;
}

export async function appendNovelRunEvent(args: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly type: NovelEventType;
  readonly stage: NovelRunStatus;
  readonly step?: NovelPipelineStepKind | null;
  readonly chapterNumber?: number | null;
  readonly progress?: number;
  readonly payload?: Record<string, unknown>;
}): Promise<void> {
  const event = await args.prisma.$transaction(async (tx) => {
    const run = await tx.novelRun.update({
      where: { id: args.runId },
      data: { lastEventSequence: { increment: 1 } },
      select: { id: true, projectId: true, lastEventSequence: true },
    });
    return tx.novelRunEvent.create({
      data: {
        runId: run.id,
        projectId: run.projectId,
        sequence: run.lastEventSequence,
        type: args.type,
        stage: args.stage,
        step: args.step ?? null,
        chapterNumber: args.chapterNumber ?? null,
        progress: Math.max(0, Math.min(100, Math.round(args.progress ?? 0))),
        payload: json(args.payload ?? {}),
      },
    });
  });
  await getRedis().publish(novelRunChannel(args.runId), String(event.sequence)).catch(() => undefined);
}

export function serializeNovelRunEvent(event: {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly type: string;
  readonly stage: string;
  readonly step: string | null;
  readonly chapterNumber: number | null;
  readonly progress: number;
  readonly payload: Prisma.JsonValue;
  readonly createdAt: Date;
}) {
  return {
    ...event,
    payload: event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {},
    createdAt: event.createdAt.toISOString(),
  };
}
