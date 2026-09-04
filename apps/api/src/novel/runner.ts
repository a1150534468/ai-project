import { hostname } from "node:os";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import {
  completedNovelChapterCount,
  decideNovelReview,
  evaluateNovelQualityGate,
  resolveNovelStoryPhase,
  type NovelPipelineStepKind,
} from "@ai-assistant/novel-workflow";
import { nextPipelineStep, runStatusForStep } from "@ai-assistant/novel-workflow/server";
import {
  createNovelGenerator,
  buildNovelQualityDiagnostics,
  reserveAndCreateTask,
  runNovelTask,
  type NovelTaskRow,
  type NovelTargetKind,
} from "../workflow/novel/index.js";
import { appendNovelRunEvent } from "./events.js";
import { createNextNovelStep } from "./run-store.js";
import { captureNovelStructuredSnapshot } from "./checkpoint-snapshot.js";
import { buildNovelRevisionGuidance, MAX_AUTOMATIC_NOVEL_REVISIONS } from "./revision.js";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "小说引擎步骤失败";
}

async function runGeneratedTarget(args: {
  readonly prisma: PrismaClient;
  readonly stepId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly targetKind: NovelTargetKind;
  readonly payload: Record<string, unknown>;
  readonly onChunk?: (chunk: string) => Promise<void>;
}) {
  let task: NovelTaskRow | null = await args.prisma.novelTask.findFirst({
    where: { projectId: args.projectId, targetId: args.stepId },
    orderBy: { createdAt: "desc" },
  });
  if (!task || task.status === "failed" || task.status === "cancelled") {
    task = await reserveAndCreateTask({
      prisma: args.prisma,
      userId: args.userId,
      projectId: args.projectId,
      targetKind: args.targetKind,
      targetId: args.stepId,
      payload: args.payload,
    });
  }
  if (task.status !== "succeeded") {
    await runNovelTask({
      prisma: args.prisma,
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
      readonly autoReview: boolean;
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
    const revisionGuidance = stringArray(input.revisionGuidance as Prisma.JsonValue | undefined);
    let chunkBuffer = "";
    const emitChunk = async (force = false) => {
      if (!chunkBuffer || (!force && Array.from(chunkBuffer).length < 160)) return;
      const text = chunkBuffer;
      chunkBuffer = "";
      await appendNovelRunEvent({ prisma, runId: step.run.id, type: "chapterChunk", stage: "writing", step: "writeChapter", chapterNumber, progress: 50, payload: { text } });
    };
    const task = await runGeneratedTarget({
      prisma,
      stepId: step.id,
      projectId: project.id,
      userId: step.run.userId,
      targetKind: "chapter",
      payload: {
        chapterIndex: chapterNumber,
        title: chapter.title,
        summary: [chapter.outline || chapter.summary, revisionGuidance.length ? `本次为质量返修，必须解决：${revisionGuidance.join("；")}` : ""].filter(Boolean).join("\n"),
        targetChars: step.run.targetCharsPerChapter,
      },
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
      contentChars: chapter.billableChars || Array.from(chapter.content).filter((char) => /\S/u.test(char)).length,
      targetChars: step.run.targetCharsPerChapter,
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
    });
    return { narrativeEvents: eventCards.length, openThreads: stringArray(chapter.openThreads).length };
  }

  if (kind === "scoreTension") {
    const quality = buildNovelQualityDiagnostics(chapter.content);
    const plot = quality.tensionDimensions.plot;
    const emotional = quality.tensionDimensions.emotional;
    const pacing = quality.tensionDimensions.pacing;
    await prisma.novelChapter.update({
      where: { id: chapter.id },
      data: {
        tensionScore: quality.tensionScore,
        plotTension: plot,
        emotionalTension: emotional,
        pacingTension: pacing,
        generationMeta: { ...record(chapter.generationMeta), tensionScoringVersion: quality.tensionDimensions.scoringVersion },
      },
    });
    return { tensionScore: quality.tensionScore, plotTension: plot, emotionalTension: emotional, pacingTension: pacing, scoringVersion: quality.tensionDimensions.scoringVersion };
  }

  if (kind === "finalizeChapter") {
    const report = await prisma.novelQualityReport.findFirst({
      where: { projectId: project.id, chapterNumber, runId: step.run.id },
      orderBy: { createdAt: "desc" },
    });
    const issues = Array.isArray(report?.issues) ? report.issues : [];
    const gateReasons = report ? evaluateNovelQualityGate({
      consistencyScore: report.consistencyScore / 100,
      styleScore: report.styleScore / 100,
      tensionScore: report.tensionScore / 100,
      highSeverityIssues: issues.filter((issue) => record(issue as Prisma.JsonValue).severity === "high").length,
      criticalIssues: 0,
      contentChars: chapter.billableChars || Array.from(chapter.content).filter((char) => /\S/u.test(char)).length,
      targetChars: step.run.targetCharsPerChapter,
    }).reasons : ["缺少章节质量报告"];
    const gatePassed = Boolean(report?.gatePassed);
    const review = decideNovelReview({ mode: step.run.mode as "assisted" | "autopilot", autoReview: step.run.autoReview, gatePassed });
    const reviewStatus = review.chapterReviewStatus;
    await prisma.novelChapter.update({
      where: { id: chapter.id },
      data: { status: "ready", reviewStatus, reviewedAt: reviewStatus === "approved" ? new Date() : null },
    });
    return { chapterNumber, gatePassed, gateReasons, qualityScore: report?.overallScore ?? 0 };
  }

  throw new Error(`unsupported novel pipeline step: ${kind}`);
}

export async function executeNovelEngineStep(args: {
  readonly stepId: string;
  readonly prisma?: PrismaClient;
  readonly workerId?: string;
}): Promise<void> {
  const prisma = args.prisma ?? getPrisma();
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
    const output = await executeStepBody({ prisma, step: initial });
    const committed = await prisma.$transaction(async (tx) => {
      const step = await tx.novelRunStep.updateMany({
        where: { id: initial.id, status: "running", workerId },
        data: { status: "succeeded", progress: 100, output: output as Prisma.InputJsonValue, completedAt: new Date(), error: null },
      });
      if (step.count === 1) await tx.novelRun.update({ where: { id: initial.runId }, data: { consecutiveFailures: 0, error: null } });
      return step.count === 1;
    });
    if (!committed) return;
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
    if (freshRun.cancelRequested) {
      await prisma.$transaction([
        prisma.novelRun.update({ where: { id: freshRun.id }, data: { status: "cancelled", completedAt: new Date() } }),
        prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { autopilotStatus: "cancelled" } }),
      ]);
      await appendNovelRunEvent({
        prisma,
        runId: freshRun.id,
        type: "runStatusChanged",
        stage: "cancelled",
        step: initial.kind as NovelPipelineStepKind,
        chapterNumber: initial.chapterNumber,
        progress: 100,
        payload: { reason: "cancelRequested" },
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
      if (freshRun.pauseRequested) {
        await prisma.$transaction([
          prisma.novelRun.update({ where: { id: freshRun.id }, data: { status: "paused" } }),
          prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { autopilotStatus: "paused" } }),
        ]);
        await appendNovelRunEvent({ prisma, runId: freshRun.id, type: "runStatusChanged", stage: "paused", step: next, chapterNumber: freshRun.currentChapter, progress: 0, payload: { reason: "pauseRequested" } });
      }
      return;
    }

    const gatePassed = output.gatePassed !== false;
    const gateReasons = Array.isArray(output.gateReasons) ? output.gateReasons.filter((reason): reason is string => typeof reason === "string") : [];
    const progressChapters = await prisma.novelChapter.findMany({
      where: { projectId: freshRun.projectId },
      select: { chapterIndex: true, content: true },
      orderBy: { chapterIndex: "asc" },
    });
    const completedCount = completedNovelChapterCount(progressChapters);
    const completedChapter = freshRun.currentChapter ?? initial.chapterNumber ?? completedCount;
    const phase = resolveNovelStoryPhase(completedCount, freshRun.targetChapters);
    if (freshRun.mode === "autopilot" && freshRun.autoReview && !gatePassed) {
      const successfulWrites = await prisma.novelRunStep.count({
        where: { runId: freshRun.id, chapterNumber: completedChapter, kind: "writeChapter", status: "succeeded" },
      });
      const completedAutomaticRevisions = Math.max(0, successfulWrites - 1);
      if (completedAutomaticRevisions < MAX_AUTOMATIC_NOVEL_REVISIONS) {
        const chapterForRevision = await prisma.novelChapter.findUniqueOrThrow({
          where: { projectId_chapterIndex: { projectId: freshRun.projectId, chapterIndex: completedChapter } },
          select: { billableChars: true, aiActionItems: true },
        });
        const actionItems = Array.isArray(chapterForRevision.aiActionItems) ? chapterForRevision.aiActionItems.filter((item): item is string => typeof item === "string") : [];
        const revisionGuidance = buildNovelRevisionGuidance({
          billableChars: chapterForRevision.billableChars,
          targetChars: freshRun.targetCharsPerChapter,
          actionItems,
          gateReasons,
        });
        const revisionAttempt = completedAutomaticRevisions + 1;
        await createNextNovelStep({
          prisma,
          runId: freshRun.id,
          kind: "writeChapter",
          chapterNumber: completedChapter,
          priority: 5,
          input: { revisionGuidance },
          runData: { status: "queued", completedChapters: completedCount, consecutiveFailures: 0, error: null, completedAt: null },
        });
        await prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { storyPhase: phase.phase, autopilotStatus: "queued" } });
        await appendNovelRunEvent({
          prisma,
          runId: freshRun.id,
          type: "runStatusChanged",
          stage: "queued",
          step: "writeChapter",
          chapterNumber: completedChapter,
          progress: 0,
          payload: { reason: "autoRevisionRequested", revisionAttempt, maxRevisionAttempts: MAX_AUTOMATIC_NOVEL_REVISIONS, gateReasons, revisionGuidance },
        });
        return;
      }
    }
    if (freshRun.mode === "autopilot" && freshRun.autoReview && gatePassed && completedChapter < freshRun.targetChapters) {
      const nextStatus = freshRun.pauseRequested ? "paused" as const : "queued" as const;
      await prisma.$transaction([
        prisma.novelRun.update({ where: { id: freshRun.id }, data: { completedChapters: completedCount, currentChapter: completedChapter + 1, status: nextStatus, currentStep: "prepareChapter" } }),
        prisma.novelProject.update({ where: { id: freshRun.projectId }, data: { storyPhase: phase.phase, autopilotStatus: nextStatus } }),
      ]);
      await appendNovelRunEvent({ prisma, runId: freshRun.id, type: "chapterCompleted", stage: nextStatus, step: "finalizeChapter", chapterNumber: completedChapter, progress: 100, payload: { nextChapter: completedChapter + 1 } });
      await createNextNovelStep({ prisma, runId: freshRun.id, kind: "prepareChapter", chapterNumber: completedChapter + 1, priority: 5 });
      if (freshRun.pauseRequested) await appendNovelRunEvent({ prisma, runId: freshRun.id, type: "runStatusChanged", stage: "paused", step: "prepareChapter", chapterNumber: completedChapter + 1, progress: 0, payload: { reason: "pauseRequested" } });
      return;
    }

    const review = decideNovelReview({ mode: freshRun.mode as "assisted" | "autopilot", autoReview: freshRun.autoReview, gatePassed });
    const finalStatus = review.requiresHumanReview ? "awaitingReview" : "completed";
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
      payload: { gatePassed, gateReasons, reason: review.reason ?? "targetCompleted" },
    });
  } catch (error) {
    const message = safeMessage(error);
    const latest = await prisma.novelRun.findUniqueOrThrow({ where: { id: initial.runId } });
    if (latest.cancelRequested || latest.status === "cancelled") {
      await prisma.$transaction([
        prisma.novelRunStep.update({ where: { id: initial.id }, data: { status: "cancelled", error: "用户已取消", workerId: null, completedAt: new Date() } }),
        prisma.novelProject.update({ where: { id: initial.run.projectId }, data: { autopilotStatus: "cancelled" } }),
      ]);
      return;
    }
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
