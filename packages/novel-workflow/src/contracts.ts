import { z } from "zod";

export const NOVEL_RUN_MODES = ["assisted", "autopilot"] as const;
export const novelRunModeSchema = z.enum(NOVEL_RUN_MODES);
export type NovelRunMode = z.infer<typeof novelRunModeSchema>;

export const NOVEL_RUN_STATUSES = [
  "queued",
  "planning",
  "writing",
  "validating",
  "postprocessing",
  "awaitingReview",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const novelRunStatusSchema = z.enum(NOVEL_RUN_STATUSES);
export type NovelRunStatus = z.infer<typeof novelRunStatusSchema>;

export const NOVEL_PIPELINE_STEP_KINDS = [
  "prepareChapter",
  "assembleContext",
  "writeChapter",
  "validateContent",
  "auditVoice",
  "postprocessChapter",
  "scoreTension",
  "finalizeChapter",
] as const;
export const novelPipelineStepKindSchema = z.enum(NOVEL_PIPELINE_STEP_KINDS);
export type NovelPipelineStepKind = z.infer<typeof novelPipelineStepKindSchema>;

export const NOVEL_STEP_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const novelStepStatusSchema = z.enum(NOVEL_STEP_STATUSES);
export type NovelStepStatus = z.infer<typeof novelStepStatusSchema>;

export const NOVEL_EVENT_TYPES = [
  "runQueued",
  "runStatusChanged",
  "stepStarted",
  "stepProgress",
  "chapterChunk",
  "stepCompleted",
  "stepFailed",
  "chapterCompleted",
  "reviewRequired",
  "balanceRequired",
  "circuitOpened",
  "runCompleted",
] as const;
export const novelEventTypeSchema = z.enum(NOVEL_EVENT_TYPES);
export type NovelEventType = z.infer<typeof novelEventTypeSchema>;

export const novelRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  chapterNumber: z.number().int().positive().nullable(),
  type: novelEventTypeSchema,
  stage: novelRunStatusSchema,
  step: novelPipelineStepKindSchema.nullable(),
  progress: z.number().min(0).max(100),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type NovelRunEvent = z.infer<typeof novelRunEventSchema>;

export const novelAutopilotStartSchema = z.object({
  targetChapters: z.number().int().min(1).max(9999),
  targetCharsPerChapter: z.number().int().min(500).max(12_000).default(3000),
  startChapter: z.number().int().min(1).max(9999).optional(),
  autoReview: z.boolean().default(true),
});
export type NovelAutopilotStart = z.infer<typeof novelAutopilotStartSchema>;

export const novelAssistedRunSchema = z.object({
  chapterIndex: z.number().int().min(1).max(9999),
  title: z.string().trim().max(80).default(""),
  summary: z.string().trim().max(3000).default(""),
  targetChars: z.number().int().min(500).max(12_000).default(3000),
});
export type NovelAssistedRun = z.infer<typeof novelAssistedRunSchema>;

export interface NovelRunSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly mode: NovelRunMode;
  readonly status: NovelRunStatus;
  readonly currentStep: NovelPipelineStepKind | null;
  readonly currentChapter: number | null;
  readonly targetChapters: number;
  readonly targetCharsPerChapter: number;
  readonly completedChapters: number;
  readonly consecutiveFailures: number;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NovelPipelineStepSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: NovelPipelineStepKind;
  readonly status: NovelStepStatus;
  readonly chapterNumber: number | null;
  readonly attempt: number;
  readonly progress: number;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown> | null;
  readonly error: string | null;
}
