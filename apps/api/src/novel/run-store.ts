import { Prisma, type PrismaClient } from "@prisma/client";
import type { NovelPipelineStepKind, NovelRunMode } from "@ai-assistant/novel-workflow/contracts";
import { pipelineForMode } from "@ai-assistant/novel-workflow/server";

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function serializeNovelRun(run: {
  readonly id: string;
  readonly projectId: string;
  readonly mode: string;
  readonly status: string;
  readonly currentStep: string | null;
  readonly currentChapter: number | null;
  readonly targetChapters: number;
  readonly targetCharsPerChapter: number;
  readonly autoReview: boolean;
  readonly completedChapters: number;
  readonly consecutiveFailures: number;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: run.id,
    projectId: run.projectId,
    mode: run.mode,
    status: run.status,
    currentStep: run.currentStep,
    currentChapter: run.currentChapter,
    targetChapters: run.targetChapters,
    targetCharsPerChapter: run.targetCharsPerChapter,
    autoReview: run.autoReview,
    completedChapters: run.completedChapters,
    consecutiveFailures: run.consecutiveFailures,
    pauseRequested: run.pauseRequested,
    cancelRequested: run.cancelRequested,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function createNovelRun(args: {
  readonly prisma: PrismaClient;
  readonly projectId: string;
  readonly userId: string;
  readonly mode: NovelRunMode;
  readonly startChapter: number;
  readonly targetChapters: number;
  readonly targetCharsPerChapter: number;
  readonly completedChapters?: number;
  readonly autoReview: boolean;
  readonly input?: Record<string, unknown>;
}) {
  const includePlanning = false;
  const firstKind = pipelineForMode(args.mode, includePlanning)[0]!;
  return args.prisma.$transaction(async (tx) => {
    const run = await tx.novelRun.create({
      data: {
        projectId: args.projectId,
        userId: args.userId,
        mode: args.mode,
        status: "queued",
        currentStep: firstKind,
        currentChapter: args.startChapter,
        startChapter: args.startChapter,
        targetChapters: args.targetChapters,
        targetCharsPerChapter: args.targetCharsPerChapter,
        completedChapters: args.completedChapters ?? 0,
        autoReview: args.autoReview,
      },
    });
    const step = await tx.novelRunStep.create({
      data: {
        runId: run.id,
        sequence: 1,
        kind: firstKind,
        chapterNumber: args.startChapter,
        priority: args.mode === "assisted" ? 1 : 5,
        input: json(args.input ?? {}),
      },
    });
    await tx.novelCommandOutbox.create({
      data: {
        projectId: args.projectId,
        runId: run.id,
        stepId: step.id,
        payload: json({ type: "engine-step", stepId: step.id }),
        priority: step.priority,
      },
    });
    await tx.novelRunEvent.create({
      data: {
        runId: run.id,
        projectId: args.projectId,
        sequence: 1,
        type: "runQueued",
        stage: "queued",
        step: firstKind,
        chapterNumber: run.currentChapter,
        progress: 0,
        payload: json({ mode: args.mode }),
      },
    });
    await tx.novelRun.update({ where: { id: run.id }, data: { lastEventSequence: 1 } });
    return { run, step };
  });
}

export async function createNextNovelStep(args: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly kind: NovelPipelineStepKind;
  readonly chapterNumber: number | null;
  readonly input?: Record<string, unknown>;
  readonly priority: number;
  readonly runData?: Prisma.NovelRunUpdateInput;
}) {
  return args.prisma.$transaction(async (tx) => {
    const aggregate = await tx.novelRunStep.aggregate({ where: { runId: args.runId }, _max: { sequence: true } });
    const run = await tx.novelRun.findUniqueOrThrow({ where: { id: args.runId } });
    const step = await tx.novelRunStep.create({
      data: {
        runId: args.runId,
        sequence: (aggregate._max.sequence ?? 0) + 1,
        kind: args.kind,
        chapterNumber: args.chapterNumber,
        priority: args.priority,
        input: json(args.input ?? {}),
      },
    });
    await tx.novelCommandOutbox.create({
      data: {
        projectId: run.projectId,
        runId: run.id,
        stepId: step.id,
        payload: json({ type: "engine-step", stepId: step.id }),
        priority: args.priority,
      },
    });
    await tx.novelRun.update({
      where: { id: run.id },
      data: { ...args.runData, currentStep: args.kind, currentChapter: args.chapterNumber ?? run.currentChapter },
    });
    return step;
  });
}
