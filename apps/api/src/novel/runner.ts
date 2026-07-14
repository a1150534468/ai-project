import { hostname } from "node:os";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import {
  evaluateNovelQualityGate,
  resolveNovelStoryPhase,
  type NovelPipelineStepKind,
} from "@ai-assistant/novel-workflow";
import { nextPipelineStep, runStatusForStep } from "@ai-assistant/novel-workflow/server";
import { createNovelGenerator } from "../workflow/novel-generation.js";
import { buildNovelQualityDiagnostics } from "../workflow/novel-text-analysis.js";
import {
  estimateReserveChars,
  reserveAndCreateTask,
  runNovelTask,
  type BillingForNovels,
  type NovelTaskRow,
} from "../workflow/novel-task-runner.js";
import type { NovelTargetKind } from "../workflow/novel-types.js";
import { appendNovelRunEvent } from "./events.js";
import { createNextNovelStep } from "./run-store.js";
import { captureNovelStructuredSnapshot } from "./checkpoint-snapshot.js";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "小说引擎步骤失败";
}

function billingClient(): BillingForNovels {
  return createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
}

async function runGeneratedTarget(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForNovels;
  readonly stepId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly targetKind: NovelTargetKind;
  readonly payload: Record<string, unknown>;
  readonly estimateChars: number;
  readonly onChunk?: (chunk: string) => Promise<void>;
}) {
  let task: NovelTaskRow | null = await args.prisma.novelTask.findFirst({
    where: { projectId: args.projectId, targetId: args.stepId },
    orderBy: { createdAt: "desc" },
  });
  if (!task || task.status === "failed" || task.status === "cancelled") {
    task = await reserveAndCreateTask({
      prisma: args.prisma,
      billing: args.billing,
      userId: args.userId,
      projectId: args.projectId,
      targetKind: args.targetKind,
      targetId: args.stepId,
      payload: args.payload,
      estimateChars: args.estimateChars,
    });
  }
  if (task.status !== "succeeded") {
    await runNovelTask({
      prisma: args.prisma,
      billing: args.billing,
      generator: createNovelGenerator(),
      task,
      onChunk: args.onChunk,
    });
  }
  const completed = await args.prisma.novelTask.findUniqueOrThrow({ where: { id: task.id } });
  if (completed.status !== "succeeded") throw new Error(completed.error || "模型生成失败");
  return completed;
}

async function executeStepBody(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForNovels;
  readonly step: {
    readonly id: string;
    readonly kind: string;
    readonly chapterNumber: number | null;
    readonly input: Prisma.JsonValue;
    readonly run: {
      readonly id: string;
      readonly projectId: string;
      readonly userId: string;
      readonly mode: string;
      readonly targetCharsPerChapter: number;
    };
  };
}): Promise<Record<string, unknown>> {
  const { prisma, step } = args;
  const project = await prisma.novelProject.findUniqueOrThrow({ where: { id: step.run.projectId } });
  const kind = step.kind as NovelPipelineStepKind;
  const chapterNumber = step.chapterNumber ?? 1;
  const input = record(step.input);

  if (kind === "prepareChapter") {
    const plannedChapter = await prisma.novelChapter.findUnique({ where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: chapterNumber } } });
    const structureNode = await prisma.novelStructureNode.findFirst({ where: { projectId: project.id, nodeType: "chapter", number: chapterNumber } });
    const title = String(input.title ?? plannedChapter?.title ?? structureNode?.title ?? `第 ${chapterNumber} 章`);
    const summary = String(input.summary ?? plannedChapter?.outline ?? plannedChapter?.summary ?? structureNode?.outline ?? "推进主线，并留下下一章压力。");
    await prisma.$transaction(async (tx) => {
      const branchName = project.currentBranch || "main";
      const [snapshotChapters, structured] = await Promise.all([
        tx.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, volumeIndex: true, title: true, summary: true, outline: true, generationHint: true, executionPlan: true, microBeats: true, content: true, rawContent: true, openThreads: true, contextSnapshot: true, generationMeta: true, consistencyJson: true, status: true, reviewStatus: true, reviewNotes: true, aiReview: true, aiActionItems: true, modificationRate: true, billableChars: true, tensionScore: true, plotTension: true, emotionalTension: true, pacingTension: true, qualityScore: true } }),
        captureNovelStructuredSnapshot(tx, project.id),
      ]);
      await tx.novelCheckpoint.updateMany({ where: { projectId: project.id, branchName, isHead: true }, data: { isHead: false } });
      const parent = await tx.novelCheckpoint.findFirst({ where: { projectId: project.id, branchName }, orderBy: { createdAt: "desc" } });
      await tx.novelCheckpoint.create({
        data: {
          projectId: project.id,
          branchName,
          parentId: parent?.id ?? null,
          chapterNumber,
          label: `生成第 ${chapterNumber} 章前`,
          isHead: true,
          snapshot: {
            chapterNumber,
            project: { title: project.title, genre: project.genre, premise: project.premise, settings: project.settings, generationPrefs: project.generationPrefs, narrativeContract: project.narrativeContract, storyPhase: project.storyPhase },
            chapters: snapshotChapters,
            structured,
          },
        },
      });
      await tx.novelChapter.upsert({
        where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: chapterNumber } },
        create: { projectId: project.id, chapterIndex: chapterNumber, title, summary, outline: summary, status: "draft" },
        update: { title, summary, outline: summary, status: "draft" },
      });
    });
    return { chapterNumber, title, summary, checkpointCreated: true };
  }

  if (kind === "assembleContext") {
    const [bible, worldDimensions, styleNotes, recentChapters, facts, foreshadows, characters, storylines] = await Promise.all([
      prisma.novelBible.count({ where: { projectId: project.id } }),
      prisma.novelWorldDimension.count({ where: { projectId: project.id } }),
      prisma.novelStyleNote.count({ where: { projectId: project.id } }),
      prisma.novelChapter.findMany({ where: { projectId: project.id, chapterIndex: { lt: chapterNumber } }, orderBy: { chapterIndex: "desc" }, take: 5 }),
      prisma.novelKnowledgeFact.count({ where: { projectId: project.id, status: "confirmed" } }),
      prisma.novelForeshadowItem.count({ where: { projectId: project.id, status: { in: ["open", "hinted"] } } }),
      prisma.novelCharacter.count({ where: { projectId: project.id } }),
      prisma.novelStoryline.count({ where: { projectId: project.id, status: "active" } }),
    ]);
    return {
      chapterNumber,
      layers: {
        bible,
        worldDimensions,
        styleNotes,
        recentChapters: recentChapters.length,
        facts,
        foreshadows,
        characters,
        storylines,
      },
    };
  }

  if (kind === "writeChapter") {
    const chapter = await prisma.novelChapter.findUniqueOrThrow({
      where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: chapterNumber } },
    });
    let chunkBuffer = "";
    const emitChunk = async (force = false) => {
      if (!chunkBuffer || (!force && Array.from(chunkBuffer).length < 160)) return;
      const text = chunkBuffer;
      chunkBuffer = "";
      await appendNovelRunEvent({ prisma, runId: step.run.id, type: "chapterChunk", stage: "writing", step: "writeChapter", chapterNumber, progress: 50, payload: { text } });
    };
    const task = await runGeneratedTarget({
      prisma,
      billing: args.billing,
      stepId: step.id,
      projectId: project.id,
      userId: step.run.userId,
      targetKind: "chapter",
      payload: {
        chapterIndex: chapterNumber,
        title: chapter.title,
        summary: chapter.summary,
        targetChars: step.run.targetCharsPerChapter,
      },
      estimateChars: estimateReserveChars("chapter", step.run.targetCharsPerChapter),
      onChunk: async (chunk) => {
        chunkBuffer += chunk;
        await emitChunk(false);
      },
    });
    await emitChunk(true);
    const saved = await prisma.novelChapter.findUniqueOrThrow({
      where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: chapterNumber } },
    });
    return { taskId: task.id, chapterId: saved.id, billableChars: saved.billableChars };
  }

  const chapter = await prisma.novelChapter.findUniqueOrThrow({
    where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: chapterNumber } },
  });

  if (kind === "validateContent") {
    const quality = buildNovelQualityDiagnostics(chapter.content);
    const consistency = record(chapter.consistencyJson);
    const risks = Array.isArray(consistency.risks) ? consistency.risks : [];
    const highSeverityIssues = quality.issues.filter((issue) => issue.severity === "high").length;
    const styleScore = quality.styleRisk === "low" ? 0.9 : quality.styleRisk === "medium" ? 0.7 : 0.45;
    const gate = evaluateNovelQualityGate({
      consistencyScore: risks.length === 0 ? 0.9 : Math.max(0.4, 0.9 - risks.length * 0.1),
      styleScore,
      tensionScore: quality.tensionScore / 100,
      highSeverityIssues,
      criticalIssues: 0,
    });
    await prisma.$transaction([
      prisma.novelQualityReport.deleteMany({ where: { projectId: project.id, chapterNumber, runId: step.run.id } }),
      prisma.novelQualityReport.create({
        data: {
          projectId: project.id,
          chapterId: chapter.id,
          chapterNumber,
          runId: step.run.id,
          overallScore: gate.score,
          consistencyScore: risks.length === 0 ? 90 : Math.max(40, 90 - risks.length * 10),
          styleScore: styleScore * 100,
          tensionScore: quality.tensionScore,
          issues: quality.issues as unknown as Prisma.InputJsonValue,
          metrics: quality.metrics as unknown as Prisma.InputJsonValue,
          gatePassed: gate.passed,
        },
      }),
      prisma.novelChapter.update({ where: { id: chapter.id }, data: { qualityScore: gate.score } }),
    ]);
    return { quality, gate };
  }

  if (kind === "auditVoice") {
    const quality = buildNovelQualityDiagnostics(chapter.content);
    return {
      styleScore: quality.styleRisk === "low" ? 90 : quality.styleRisk === "medium" ? 70 : 45,
      driftAlert: quality.styleRisk === "high",
      clicheHits: quality.clicheHits,
    };
  }

  if (kind === "postprocessChapter") {
    const consistency = record(chapter.consistencyJson);
    const assets = record(consistency.chapterAssets as Prisma.JsonValue | undefined);
    const eventCards = Array.isArray(assets.eventCards) ? assets.eventCards.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    await prisma.$transaction(async (tx) => {
      await tx.novelNarrativeEvent.deleteMany({ where: { projectId: project.id, chapterNumber } });
      for (const item of eventCards) {
        await tx.novelNarrativeEvent.create({
          data: {
            projectId: project.id,
            chapterNumber,
            eventType: String(item.eventType ?? "progress"),
            title: String(item.label ?? `第 ${chapterNumber} 章事件`).slice(0, 120),
            description: String(item.evidence ?? ""),
            actors: Array.isArray(item.actors) ? item.actors as Prisma.InputJsonValue : [],
            locations: Array.isArray(item.locations) ? item.locations as Prisma.InputJsonValue : [],
            tension: item.tensionLevel === "high" ? 80 : item.tensionLevel === "medium" ? 55 : 30,
          },
        });
      }
      await tx.novelNarrativeDebt.deleteMany({ where: { projectId: project.id, introducedChapter: chapterNumber } });
      for (const thread of stringArray(chapter.openThreads)) {
        await tx.novelNarrativeDebt.create({
          data: {
            projectId: project.id,
            debtType: "openThread",
            title: thread.slice(0, 120),
            description: thread,
            introducedChapter: chapterNumber,
            dueChapter: chapterNumber + 3,
          },
        });
      }
    });
    return { narrativeEvents: eventCards.length, openThreads: stringArray(chapter.openThreads).length };
  }

  if (kind === "scoreTension") {
    const quality = buildNovelQualityDiagnostics(chapter.content);
    const plot = Math.min(100, Math.round(quality.tensionScore * 1.05));
    const emotional = Math.min(100, Math.round(quality.tensionScore * (quality.metrics.dialogueRatio > 0.1 ? 1 : 0.8)));
    const pacing = Math.min(100, Math.round((quality.score + quality.tensionScore) / 2));
    await prisma.novelChapter.update({
      where: { id: chapter.id },
      data: { tensionScore: quality.tensionScore, plotTension: plot, emotionalTension: emotional, pacingTension: pacing },
    });
    return { tensionScore: quality.tensionScore, plotTension: plot, emotionalTension: emotional, pacingTension: pacing };
  }

  if (kind === "finalizeChapter") {
    const report = await prisma.novelQualityReport.findFirst({
      where: { projectId: project.id, chapterNumber, runId: step.run.id },
      orderBy: { createdAt: "desc" },
    });
    await prisma.novelChapter.update({
      where: { id: chapter.id },
      data: { status: "ready", reviewStatus: report?.gatePassed ? "approved" : "revise", reviewedAt: new Date() },
    });
    return { chapterNumber, gatePassed: Boolean(report?.gatePassed), qualityScore: report?.overallScore ?? 0 };
  }

  throw new Error(`unsupported novel pipeline step: ${kind}`);
}

export async function executeNovelEngineStep(args: {
  readonly stepId: string;
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForNovels;
  readonly workerId?: string;
}): Promise<void> {
  const prisma = args.prisma ?? getPrisma();
  const billing = args.billing ?? billingClient();
  const workerId = args.workerId ?? `${hostname()}:${process.pid}`;
  const initial = await prisma.novelRunStep.findUnique({ where: { id: args.stepId }, include: { run: true } });
  if (!initial || initial.status === "succeeded" || initial.status === "cancelled") return;
  if (initial.run.cancelRequested) {
    await prisma.$transaction([
      prisma.novelRunStep.update({ where: { id: initial.id }, data: { status: "cancelled", completedAt: new Date() } }),
      prisma.novelRun.update({ where: { id: initial.runId }, data: { status: "cancelled", completedAt: new Date() } }),
    ]);
    return;
  }
  if (initial.run.pauseRequested) {
    await prisma.novelRun.update({ where: { id: initial.runId }, data: { status: "paused" } });
    return;
  }

  const claimed = await prisma.novelRunStep.updateMany({
    where: { id: initial.id, status: { in: ["queued", "failed"] } },
    data: { status: "running", workerId, attempt: { increment: 1 }, progress: 1, error: null, startedAt: new Date() },
  });
  if (claimed.count !== 1) return;
  const status = runStatusForStep(initial.kind as NovelPipelineStepKind);
  await prisma.$transaction([
    prisma.novelRun.update({
      where: { id: initial.runId },
      data: { status, currentStep: initial.kind, currentChapter: initial.chapterNumber ?? initial.run.currentChapter, startedAt: initial.run.startedAt ?? new Date(), error: null },
    }),
    prisma.novelProject.update({ where: { id: initial.run.projectId }, data: { autopilotStatus: status } }),
  ]);
  await appendNovelRunEvent({
    prisma,
    runId: initial.runId,
    type: "stepStarted",
    stage: status,
    step: initial.kind as NovelPipelineStepKind,
    chapterNumber: initial.chapterNumber,
    progress: 1,
  });
  const heartbeat = setInterval(() => {
    void prisma.novelRunStep.updateMany({
      where: { id: initial.id, status: "running", workerId },
      data: { progress: 1 },
    }).catch(() => undefined);
  }, 30_000);

  try {
    const output = await executeStepBody({ prisma, billing, step: initial });
    await prisma.$transaction([
      prisma.novelRunStep.update({ where: { id: initial.id }, data: { status: "succeeded", progress: 100, output: output as Prisma.InputJsonValue, completedAt: new Date(), error: null } }),
      prisma.novelRun.update({ where: { id: initial.runId }, data: { consecutiveFailures: 0, error: null } }),
    ]);
    await appendNovelRunEvent({
      prisma,
      runId: initial.runId,
      type: "stepCompleted",
      stage: status,
      step: initial.kind as NovelPipelineStepKind,
      chapterNumber: initial.chapterNumber,
      progress: 100,
      payload: output,
    });

    const freshRun = await prisma.novelRun.findUniqueOrThrow({ where: { id: initial.runId } });
    if (freshRun.cancelRequested || freshRun.pauseRequested) {
      const requestedStatus = freshRun.cancelRequested ? "cancelled" as const : "paused" as const;
      await prisma.$transaction([
        prisma.novelRun.update({ where: { id: freshRun.id }, data: { status: requestedStatus, completedAt: requestedStatus === "cancelled" ? new Date() : null } }),
        prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { autopilotStatus: requestedStatus } }),
      ]);
      await appendNovelRunEvent({
        prisma,
        runId: freshRun.id,
        type: "runStatusChanged",
        stage: requestedStatus,
        step: initial.kind as NovelPipelineStepKind,
        chapterNumber: initial.chapterNumber,
        progress: 100,
        payload: { reason: freshRun.cancelRequested ? "cancelRequested" : "pauseRequested" },
      });
      return;
    }
    const next = nextPipelineStep(freshRun.mode as "assisted" | "autopilot", initial.kind as NovelPipelineStepKind, false);
    if (next) {
      await createNextNovelStep({
        prisma,
        runId: freshRun.id,
        kind: next,
        chapterNumber: freshRun.currentChapter,
        priority: freshRun.mode === "assisted" ? 1 : 5,
      });
      return;
    }

    const gatePassed = output.gatePassed !== false;
    const completedCount = await prisma.novelChapter.count({ where: { projectId: freshRun.projectId, status: "ready" } });
    const completedChapter = freshRun.currentChapter ?? initial.chapterNumber ?? completedCount;
    const phase = resolveNovelStoryPhase(completedCount, freshRun.targetChapters);
    if (freshRun.mode === "autopilot" && freshRun.autoReview && gatePassed && completedChapter < freshRun.targetChapters) {
      await prisma.$transaction([
        prisma.novelRun.update({ where: { id: freshRun.id }, data: { completedChapters: completedCount, currentChapter: completedChapter + 1, status: "queued", currentStep: "prepareChapter" } }),
        prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { storyPhase: phase.phase, autopilotStatus: "queued" } }),
      ]);
      await appendNovelRunEvent({ prisma, runId: freshRun.id, type: "chapterCompleted", stage: "queued", step: "finalizeChapter", chapterNumber: completedChapter, progress: 100, payload: { nextChapter: completedChapter + 1 } });
      await createNextNovelStep({ prisma, runId: freshRun.id, kind: "prepareChapter", chapterNumber: completedChapter + 1, priority: 5 });
      return;
    }

    const finalStatus = freshRun.mode === "assisted" || !gatePassed ? "awaitingReview" : "completed";
    await prisma.$transaction([
      prisma.novelRun.update({ where: { id: freshRun.id }, data: { status: finalStatus, completedChapters: completedCount, completedAt: finalStatus === "completed" ? new Date() : null } }),
      prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { storyPhase: phase.phase, autopilotStatus: finalStatus } }),
    ]);
    await appendNovelRunEvent({
      prisma,
      runId: freshRun.id,
      type: finalStatus === "completed" ? "runCompleted" : "reviewRequired",
      stage: finalStatus,
      step: "finalizeChapter",
      chapterNumber: completedChapter,
      progress: 100,
      payload: { gatePassed },
    });
  } catch (error) {
    const message = safeMessage(error);
    if (error instanceof InsufficientBalanceError || (error instanceof Error && error.name === "InsufficientBalanceError")) {
      await prisma.$transaction([
        prisma.novelRunStep.update({ where: { id: initial.id }, data: { status: "queued", error: message, workerId: null } }),
        prisma.novelRun.update({ where: { id: initial.runId }, data: { status: "paused", pauseRequested: true, error: message } }),
        prisma.novelProject.update({ where: { id: initial.run.projectId }, data: { autopilotStatus: "paused" } }),
      ]);
      await appendNovelRunEvent({
        prisma,
        runId: initial.runId,
        type: "balanceRequired",
        stage: "paused",
        step: initial.kind as NovelPipelineStepKind,
        chapterNumber: initial.chapterNumber,
        progress: 100,
        payload: { error: message, code: "INSUFFICIENT_BALANCE" },
      });
      return;
    }
    const latest = await prisma.novelRun.findUniqueOrThrow({ where: { id: initial.runId } });
    const failures = latest.consecutiveFailures + 1;
    const circuitOpen = failures >= 3;
    await prisma.$transaction([
      prisma.novelRunStep.update({ where: { id: initial.id }, data: { status: circuitOpen ? "failed" : "queued", error: message, workerId: null } }),
      prisma.novelRun.update({ where: { id: initial.runId }, data: { status: circuitOpen ? "failed" : status, consecutiveFailures: failures, error: message, completedAt: circuitOpen ? new Date() : null } }),
      prisma.novelProject.update({ where: { id: initial.run.projectId }, data: { autopilotStatus: circuitOpen ? "failed" : status } }),
    ]);
    await appendNovelRunEvent({
      prisma,
      runId: initial.runId,
      type: circuitOpen ? "circuitOpened" : "stepFailed",
      stage: circuitOpen ? "failed" : status,
      step: initial.kind as NovelPipelineStepKind,
      chapterNumber: initial.chapterNumber,
      progress: 100,
      payload: { error: message, consecutiveFailures: failures },
    });
    if (!circuitOpen) throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
