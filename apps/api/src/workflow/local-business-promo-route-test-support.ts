import { vi } from "vitest";
import {
  createBillingMock,
  createEmptyMaterials,
  seedProject,
} from "./local-business-promo-route-test-fixtures.js";

type ProjectRow = {
  id: string;
  userId: string;
  title: string;
  brief: Record<string, unknown>;
  materials: Record<string, unknown>;
  settings: Record<string, unknown>;
  scriptDraft: string;
  latestRunId: string | null;
  voiceCloneSampleAssetId: string | null;
  activeNarrationAssetId: string | null;
  activeBgmAssetId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type RunRow = {
  id: string;
  projectId: string;
  userId: string;
  billingOperationId: string | null;
  billingRefundedAt: Date | null;
  billingRefundStatus: string;
  billingRefundError: string | null;
  billingRefundRetryCount: number;
  billingRefundLastAttemptAt: Date | null;
  billingRefundNextRetryAt: Date | null;
  settingsSnapshot: unknown;
  scriptSnapshot: string;
  shotPlan: unknown;
  analysisSnapshot: unknown;
  clipRequestIds: string[];
  mergedAssetId: string | null;
  narrationAssetId: string | null;
  bgmAssetId: string | null;
  status: string;
  progressPercent: number;
  progressStage: string;
  progressMessage: string | null;
  error: string | null;
  startedAt: Date | null;
  workerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type VideoAssetRow = {
  id: string;
  userId: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  originalUrl: string;
  objectKey: string | null;
  mime: string;
  format: string;
  createdAt: Date;
};

type VideoTaskRow = {
  id: string;
  userId: string;
  requestId: string;
  providerTaskId: string | null;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  generateAudio: boolean;
  hasInputVideo: boolean;
  resourceKey: string;
  chargedPoints: number;
  status: string;
  progress: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type AudioAssetRow = {
  id: string;
  userId: string;
  projectId: string | null;
  requestId: string | null;
  kind: string;
  source: string;
  provider: string | null;
  providerModel: string | null;
  originalUrl: string;
  objectKey: string | null;
  mime: string;
  format: string;
  durationSec: number;
  textContent: string | null;
  metadata: unknown;
  createdAt: Date;
};

type AudioTaskRow = {
  id: string;
  userId: string;
  projectId: string | null;
  requestId: string;
  kind: string;
  provider: string | null;
  providerModel: string | null;
  status: string;
  error: string | null;
  inputPayload: unknown;
  resultPayload: unknown;
  assetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type PrismaMock = {
  localBusinessPromoProject: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  localBusinessPromoRun: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  videoAsset: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  videoGenerationTask: {
    findMany: ReturnType<typeof vi.fn>;
  };
  audioAsset: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  audioGenerationTask: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  __state: {
    projects: ProjectRow[];
    runs: RunRow[];
    videoAssets: VideoAssetRow[];
    videoTasks: VideoTaskRow[];
    audioAssets: AudioAssetRow[];
    audioTasks: AudioTaskRow[];
  };
};

export function createPrismaMock(seed?: {
  projects?: ProjectRow[];
  runs?: RunRow[];
  videoAssets?: VideoAssetRow[];
  videoTasks?: VideoTaskRow[];
  audioAssets?: AudioAssetRow[];
  audioTasks?: AudioTaskRow[];
}): PrismaMock {
  const projects = [...(seed?.projects ?? [])];
  const runs = [...(seed?.runs ?? [])];
  const videoAssets = [...(seed?.videoAssets ?? [])];
  const videoTasks = [...(seed?.videoTasks ?? [])];
  const audioAssets = [...(seed?.audioAssets ?? [])];
  const audioTasks = [...(seed?.audioTasks ?? [])];
  const prisma = {} as PrismaMock;

  prisma.localBusinessPromoProject = {
    findMany: vi.fn(async ({ where, take }: { where?: { userId?: string }; take?: number } = {}) =>
      projects
        .filter((row) => !where?.userId || row.userId === where.userId)
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .slice(0, take ?? projects.length)),
    create: vi.fn(async ({ data }: { data: Omit<ProjectRow, "id" | "createdAt" | "updatedAt"> }) => {
      const row: ProjectRow = {
        ...data,
        voiceCloneSampleAssetId: data.voiceCloneSampleAssetId ?? null,
        activeNarrationAssetId: data.activeNarrationAssetId ?? null,
        activeBgmAssetId: data.activeBgmAssetId ?? null,
        id: `project-${projects.length + 1}`,
        createdAt: new Date("2026-07-06T08:00:00.000Z"),
        updatedAt: new Date("2026-07-06T08:00:00.000Z"),
      };
      projects.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      projects.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
      const row = projects.find((item) => item.id === where.id);
      if (!row) throw new Error("project not found");
      Object.assign(row, data, { updatedAt: new Date("2026-07-06T08:01:00.000Z") });
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: {
      where: Partial<Pick<ProjectRow, "id" | "userId" | "latestRunId" | "status" | "updatedAt">>;
      data: Partial<ProjectRow>;
    }) => {
      const matched = projects.filter((row) =>
        (where.id === undefined || row.id === where.id)
        && (where.userId === undefined || row.userId === where.userId)
        && (where.latestRunId === undefined || row.latestRunId === where.latestRunId)
        && (where.status === undefined || row.status === where.status)
        && (where.updatedAt === undefined || row.updatedAt.getTime() === where.updatedAt.getTime()));
      for (const row of matched) Object.assign(row, data, { updatedAt: new Date("2026-07-06T08:01:00.000Z") });
      return { count: matched.length };
    }),
  };

  prisma.localBusinessPromoRun = {
    findMany: vi.fn(async ({ where, take }: { where?: { userId?: string; projectId?: string }; take?: number } = {}) =>
      runs
        .filter((row) => (!where?.userId || row.userId === where.userId) && (!where?.projectId || row.projectId === where.projectId))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, take ?? runs.length)),
    create: vi.fn(async ({ data }: {
      data: Omit<RunRow, "id" | "createdAt" | "updatedAt" | "completedAt" | "clipRequestIds"> & {
        completedAt?: Date | null;
        clipRequestIds?: string[];
      };
    }) => {
      const row: RunRow = {
        ...data,
        billingOperationId: data.billingOperationId ?? null,
        billingRefundedAt: data.billingRefundedAt ?? null,
        billingRefundStatus: data.billingRefundStatus ?? "none",
        billingRefundError: data.billingRefundError ?? null,
        billingRefundRetryCount: data.billingRefundRetryCount ?? 0,
        billingRefundLastAttemptAt: data.billingRefundLastAttemptAt ?? null,
        billingRefundNextRetryAt: data.billingRefundNextRetryAt ?? null,
        analysisSnapshot: data.analysisSnapshot ?? null,
        clipRequestIds: data.clipRequestIds ?? [],
        narrationAssetId: data.narrationAssetId ?? null,
        bgmAssetId: data.bgmAssetId ?? null,
        progressPercent: data.progressPercent ?? 0,
        progressStage: data.progressStage ?? "queued",
        progressMessage: data.progressMessage ?? null,
        startedAt: data.startedAt ?? null,
        workerId: data.workerId ?? null,
        id: `run-${runs.length + 1}`,
        createdAt: new Date("2026-07-06T08:02:00.000Z"),
        updatedAt: new Date("2026-07-06T08:02:00.000Z"),
        completedAt: data.completedAt ?? null,
      };
      runs.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      runs.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
      const row = runs.find((item) => item.id === where.id);
      if (!row) throw new Error("run not found");
      Object.assign(row, data, { updatedAt: new Date("2026-07-06T08:03:00.000Z") });
      return row;
    }),
  };

  prisma.videoAsset = {
    create: vi.fn(async ({ data }: { data: Omit<VideoAssetRow, "id" | "createdAt"> }) => {
      const row: VideoAssetRow = {
        ...data,
        id: `video-${videoAssets.length + 1}`,
        createdAt: new Date("2026-07-06T08:04:00.000Z"),
      };
      videoAssets.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      videoAssets.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
  };

  prisma.videoGenerationTask = {
    findMany: vi.fn(async ({ where }: { where?: { userId?: string; requestId?: { in?: string[] } } } = {}) =>
      videoTasks.filter((row) =>
        (!where?.userId || row.userId === where.userId)
        && (!where?.requestId?.in || where.requestId.in.includes(row.requestId)))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())),
  };

  prisma.audioAsset = {
    create: vi.fn(async ({ data }: { data: Omit<AudioAssetRow, "id" | "createdAt"> }) => {
      const row: AudioAssetRow = {
        ...data,
        id: `audio-${audioAssets.length + 1}`,
        createdAt: new Date(`2026-07-06T08:${10 + audioAssets.length}:00.000Z`),
      };
      audioAssets.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: {
      where: { id?: string; userId?: string; projectId?: string | null; kind?: string; requestId?: string | null };
    }) =>
      audioAssets.find((row) =>
        (!where.id || row.id === where.id)
        && (!where.userId || row.userId === where.userId)
        && (where.projectId === undefined || row.projectId === where.projectId)
        && (!where.kind || row.kind === where.kind)
        && (where.requestId === undefined || row.requestId === where.requestId),
      ) ?? null),
    findMany: vi.fn(async ({ where, take }: {
      where?: { userId?: string; projectId?: string; kind?: string };
      take?: number;
    } = {}) =>
      audioAssets
        .filter((row) =>
          (!where?.userId || row.userId === where.userId)
          && (!where?.projectId || row.projectId === where.projectId)
          && (!where?.kind || row.kind === where.kind))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, take ?? audioAssets.length)),
  };

  prisma.audioGenerationTask = {
    create: vi.fn(async ({ data }: { data: Omit<AudioTaskRow, "id" | "createdAt" | "updatedAt" | "completedAt"> & { completedAt?: Date | null } }) => {
      const row: AudioTaskRow = {
        ...data,
        id: `audio-task-${audioTasks.length + 1}`,
        createdAt: new Date(`2026-07-06T08:${20 + audioTasks.length}:00.000Z`),
        updatedAt: new Date(`2026-07-06T08:${20 + audioTasks.length}:00.000Z`),
        completedAt: data.completedAt ?? null,
      };
      audioTasks.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AudioTaskRow> }) => {
      const row = audioTasks.find((item) => item.id === where.id);
      if (!row) throw new Error("audio task not found");
      Object.assign(row, data, { updatedAt: new Date("2026-07-06T08:31:00.000Z") });
      return row;
    }),
    findMany: vi.fn(async ({ where, take }: { where?: { userId?: string; projectId?: string }; take?: number } = {}) =>
      audioTasks
        .filter((row) => (!where?.userId || row.userId === where.userId) && (!where?.projectId || row.projectId === where.projectId))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, take ?? audioTasks.length)),
  };

  prisma.__state = { projects, runs, videoAssets, videoTasks, audioAssets, audioTasks };
  return prisma;
}

export { createBillingMock, createEmptyMaterials, seedProject };
