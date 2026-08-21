import Fastify from "fastify";
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import { LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GPT_IMAGE_MODEL, QWEN_IMAGE_MODEL } from "./image-service.js";
import { CODEX_PET_BAILIAN_VISUAL_QA_MODEL } from "./codex-pet-model-contract.js";
import { CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT } from "./codex-pet-call-ledger.js";
import {
  CODEX_PET_PREVIEW_ARTIFACT_PURPOSE,
  CODEX_PET_RESOURCE_KEY,
  codexPetRoutes,
  codexPetValidationPassed,
  deriveCodexPetRunId,
  signCodexPetArtifact,
  validateCodexPetReferenceAsset,
  type CodexPetBilling,
  type CodexPetRouteDeps,
} from "./codex-pet-routes.js";

const NOW = new Date("2026-07-17T12:00:00.000Z");

function completeValidationReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: "gpt-only-v1",
    modelProvenance: {
      imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-codex"] },
      visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["chatgpt_model_route"] },
    },
    deterministic: { ok: true },
    standardAtlasValidation: { ok: true },
    packagedSpritesheet: { ok: true },
    chromaDespill: { ok: true },
    directionRegistration: { ok: true },
    directionContinuity: { ok: true },
    row9PreGenerationGate: { passed: true },
    row10PreGenerationGate: { passed: true },
    blindDirectionValidation: { ok: true },
    finalVisualQa: { pass: true, identity: true, structure: true, semantics: true, continuity: true },
    directionSemantics: LOOK_DIRECTIONS.map((direction) => ({ direction, verdict: "pass" })),
    ...overrides,
  };
}

type ProjectRow = ReturnType<typeof projectRow>;
type RunRow = ReturnType<typeof runRow>;
type ArtifactRow = ReturnType<typeof artifactRow>;
type EventRow = ReturnType<typeof eventRow>;

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    userId: "u1",
    name: "代码狐",
    description: "一只喜欢检查代码的狐狸",
    prompt: "橙色小狐狸，蓝色围巾",
    actionPrompts: {},
    stylePreset: "pixel",
    styleNotes: "清爽",
    referenceAssetIds: [] as string[],
    autoContinue: false,
    imageModel: GPT_IMAGE_MODEL,
    visualQaModel: "gpt-5.6-sol",
    qualityInspectionEnabled: false,
    status: "draft",
    latestRunId: null as string | null,
    createIdempotencyKey: null as string | null,
    deletedAt: null as Date | null,
    createdAt: new Date("2026-07-17T10:00:00.000Z"),
    updatedAt: new Date("2026-07-17T10:00:00.000Z"),
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    projectId: "project-1",
    userId: "u1",
    idempotencyKey: "start-key-0001",
    inputSnapshot: {},
    status: "queued",
    progressStage: "queued",
    progressPercent: 0,
    progressMessage: "已排队" as string | null,
    autoContinue: false,
    colorKey: "#ff00ff" as string | null,
    billingOperationId: "codex-pet:run-1" as string | null,
    billingMode: "legacy_package_v1",
    billingResourceKey: null as string | null,
    billingReservedUnits: 0,
    billingSettledUnits: 0,
    billingReservedPoints: 0,
    billingSettledPoints: 0,
    billingSettlementStatus: "none",
    billingPoints: 200,
    billingChargeStatus: "charged",
    billingChargeAttemptCount: 1,
    billingChargeError: null as string | null,
    billingChargeLastAttemptAt: new Date("2026-07-17T10:01:00.000Z") as Date | null,
    billingChargeNextRetryAt: null as Date | null,
    billingChargeLeaseUntil: null as Date | null,
    billingChargedAt: new Date("2026-07-17T10:01:00.000Z") as Date | null,
    billingActivatedAt: new Date("2026-07-17T10:01:00.000Z") as Date | null,
    billingRefundedAt: null as Date | null,
    billingRefundStatus: "none",
    billingRefundError: null as string | null,
    billingRefundRetryCount: 0,
    billingRefundLastAttemptAt: null as Date | null,
    billingRefundNextRetryAt: null as Date | null,
    cancelRequested: false,
    hasSuccessfulImage: false,
    selectedBaseArtifactId: null as string | null,
    spritesheetArtifactId: null as string | null,
    packageArtifactId: null as string | null,
    previewArtifactId: null as string | null,
    validationReport: null as unknown,
    requestedModel: "gpt-image-2",
    visualQaModel: "gpt-5.6-sol",
    qualityInspectionEnabled: true,
    imageGenerationCallCount: 0,
    plannedImageCallLimit: 0,
    imageGenerationApprovalBudget: 0,
    pendingImageJobKey: null as string | null,
    actualModels: [] as string[],
    usage: null as unknown,
    knowledgeDocumentId: null as string | null,
    lastEventSequence: 0,
    workerId: null as string | null,
    heartbeatAt: null as Date | null,
    startedAt: new Date("2026-07-17T10:01:00.000Z") as Date | null,
    completedAt: null as Date | null,
    error: null as string | null,
    createdAt: new Date("2026-07-17T10:01:00.000Z"),
    updatedAt: new Date("2026-07-17T10:01:00.000Z"),
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    projectId: "project-1",
    runId: "run-1",
    userId: "u1",
    jobId: null as string | null,
    kind: "base_candidate",
    name: "候选 1",
    status: "ready",
    objectKey: "workflow/codex-pets/u1/project-1/run-1/artifact.webp",
    mime: "image/webp",
    sizeBytes: 100,
    width: 1024 as number | null,
    height: 1024 as number | null,
    checksum: null as string | null,
    metadata: {},
    expiresAt: null as Date | null,
    createdAt: new Date("2026-07-17T10:02:00.000Z"),
    updatedAt: new Date("2026-07-17T10:02:00.000Z"),
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    projectId: "project-1",
    runId: "run-1",
    userId: "u1",
    sequence: 1,
    type: "run.queued",
    stage: "queued",
    jobKey: null as string | null,
    message: "已排队" as string | null,
    progress: 0,
    payload: {},
    createdAt: new Date("2026-07-17T10:01:00.000Z"),
    ...overrides,
  };
}

function matchesScalar(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const object = condition as Record<string, unknown>;
    if (Array.isArray(object.in)) return object.in.includes(value);
    if ("not" in object && value === object.not) return false;
    if (typeof object.gt === "number") return typeof value === "number" && value > object.gt;
    if ("lte" in object) return value instanceof Date && object.lte instanceof Date && value <= object.lte;
    if ("lt" in object) return value instanceof Date && object.lt instanceof Date && value < object.lt;
    if ("gte" in object) return value instanceof Date && object.gte instanceof Date && value >= object.gte;
    return true;
  }
  return value === condition;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  if (Array.isArray(where.OR) && !where.OR.some((part) => matches(row, part as Record<string, unknown>))) return false;
  if (Array.isArray(where.AND) && !where.AND.every((part) => matches(row, part as Record<string, unknown>))) return false;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR" || key === "AND") return true;
    if (key === "id" && condition && typeof condition === "object" && "in" in condition) {
      return (condition as { in: unknown[] }).in.includes(row.id);
    }
    return matchesScalar(row[key], condition);
  });
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "increment" in value) {
      target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
    } else if (value && typeof value === "object" && !Array.isArray(value) && "decrement" in value) {
      target[key] = Number(target[key] ?? 0) - Number((value as { decrement: number }).decrement);
    } else {
      target[key] = value;
    }
  }
  target.updatedAt = new Date(NOW);
}

function createPrismaMock(seed: {
  projects?: ProjectRow[];
  runs?: RunRow[];
  artifacts?: ArtifactRow[];
  events?: EventRow[];
  images?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  imageCalls?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
} = {}) {
  const projects = seed.projects ?? [];
  const runs = seed.runs ?? [];
  const artifacts = seed.artifacts ?? [];
  const events = seed.events ?? [];
  const images = seed.images ?? [];
  const jobs = seed.jobs ?? [];
  const imageCalls = seed.imageCalls ?? [];
  const documents = seed.documents ?? runs.flatMap((run) => run.knowledgeDocumentId ? [{
    id: run.knowledgeDocumentId,
    sourceModule: "codex_pet",
    sourceId: run.id,
    kb: { userId: run.userId, systemKey: "AI_ARTIFACTS" },
  }] : []);
  const deletedDocumentSourceIds: string[] = [];
  let transactionTail = Promise.resolve();
  let transactionDepth = 0;
  let projectCounter = projects.length;
  let eventCounter = events.length;
  let jobCounter = jobs.length;
  let imageCallCounter = imageCalls.length;

  const prisma: Record<string, unknown> = {};
  const queryRaw = vi.fn(async () => [{ id: "locked-row" }]);
  const executeRaw = vi.fn(async () => 1);
  const projectDelegate = {
    findMany: vi.fn(async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
      projects.filter((row) => matches(row, where)).slice(0, take ?? projects.length)),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      projects.find((row) => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      projects.find((row) => matches(row, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      projectCounter += 1;
      const row = projectRow({
        id: `project-${projectCounter}`,
        ...data,
        referenceAssetIds: [...(data.referenceAssetIds as string[] ?? [])],
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
      projects.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = projects.find((candidate) => matches(candidate, where));
      if (!row) throw new Error("project not found");
      applyData(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = projects.filter((candidate) => matches(candidate, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = projects.length;
      for (let index = projects.length - 1; index >= 0; index -= 1) {
        if (matches(projects[index]!, where)) projects.splice(index, 1);
      }
      return { count: before - projects.length };
    }),
  };
  const runDelegate = {
    findMany: vi.fn(async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
      runs.filter((row) => matches(row, where)).slice(0, take ?? runs.length)),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      runs.find((row) => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const row = runs.find((candidate) => matches(candidate, where));
      if (!row) return null;
      return include?.project
        ? { ...row, project: projects.find((project) => project.id === row.projectId) ?? null }
        : row;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = runRow({ ...data, createdAt: new Date(NOW), updatedAt: new Date(NOW) });
      runs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = runs.find((candidate) => matches(candidate, where));
      if (!row) throw new Error("run not found");
      applyData(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = runs.filter((candidate) => matches(candidate, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    }),
  };
  const artifactDelegate = {
    findMany: vi.fn(async ({ where = {}, take, select }: {
      where?: Record<string, unknown>;
      take?: number;
      select?: Record<string, boolean>;
    } = {}) => {
      const found = artifacts.filter((row) => matches(row, where)).slice(0, take ?? artifacts.length);
      if (!select) return found;
      return found.map((row) => Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key as keyof ArtifactRow]])));
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      artifacts.find((row) => matches(row, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = artifacts.filter((row) => matches(row, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    }),
  };
  const eventDelegate = {
    findMany: vi.fn(async ({ where = {}, orderBy, take }: {
      where?: Record<string, unknown>;
      orderBy?: { sequence?: "asc" | "desc" };
      take?: number;
    } = {}) => {
      const found = events.filter((row) => matches(row, where));
      found.sort((left, right) => orderBy?.sequence === "desc" ? right.sequence - left.sequence : left.sequence - right.sequence);
      return found.slice(0, take ?? found.length);
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      eventCounter += 1;
      const row = eventRow({ id: `event-${eventCounter}`, ...data, createdAt: new Date(NOW) });
      events.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      events.find((row) => matches(row, where)) ?? null),
  };
  const jobDelegate = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => jobs.filter((row) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => jobs.find((row) => matches(row, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      jobCounter += 1;
      const row = {
        id: `job-${jobCounter}`,
        dependencyKeys: [],
        attempt: 0,
        maxAttempts: 1,
        input: {},
        output: null,
        providerMetadata: null,
        inputArtifactIds: [],
        outputArtifactIds: [],
        workerId: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        ...data,
      };
      jobs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = jobs.find((candidate) => matches(candidate, where));
      if (!row) throw new Error("job not found");
      applyData(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = jobs.filter((row) => matches(row, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    }),
  };
  const imageCallDelegate = {
    findMany: vi.fn(async ({ where = {}, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) => {
      const found = imageCalls.filter((row) => matches(row, where));
      const key = orderBy ? Object.keys(orderBy)[0] : undefined;
      if (key) found.sort((left, right) => String(left[key]).localeCompare(String(right[key])));
      return found.slice(0, take ?? found.length);
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => imageCalls.find((row) => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const compound = where.runId_jobKey_logicalAttempt as { runId: string; jobKey: string; logicalAttempt: number } | undefined;
      if (compound) return imageCalls.find((row) => row.runId === compound.runId && row.jobKey === compound.jobKey && row.logicalAttempt === compound.logicalAttempt) ?? null;
      return imageCalls.find((row) => matches(row, where)) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      imageCallCounter += 1;
      const row = { id: `image-call-${imageCallCounter}`, ...data, createdAt: new Date(NOW), updatedAt: new Date(NOW) };
      imageCalls.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = imageCalls.find((candidate) => matches(candidate, where));
      if (!row) throw new Error("image call not found");
      applyData(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = imageCalls.filter((row) => matches(row, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    }),
    count: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => imageCalls.filter((row) => matches(row, where)).length),
  };
  Object.assign(prisma, {
    codexPetProject: projectDelegate,
    codexPetRun: runDelegate,
    codexPetArtifact: artifactDelegate,
    codexPetEvent: eventDelegate,
    codexPetJob: jobDelegate,
    codexPetImageCall: imageCallDelegate,
    imageAsset: {
      findMany: vi.fn(async ({ where = {}, select }: { where?: Record<string, unknown>; select?: Record<string, boolean> } = {}) => {
        const found = images.filter((row) => {
          const idCondition = recordCondition(where.id);
          const allowedIds = Array.isArray(idCondition.in) ? idCondition.in : null;
          return matchesScalar(row.userId, where.userId) && (!allowedIds || allowedIds.includes(row.id));
        });
        if (!select) return found;
        return found.map((row) => Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])));
      }),
    },
    document: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => documents.find((row) => {
        if (!matches(row, where)) return false;
        const expectedKb = recordCondition(where.kb);
        const actualKb = recordCondition(row.kb);
        return matchesScalar(actualKb.userId, expectedKb.userId)
          && matchesScalar(actualKb.systemKey, expectedKb.systemKey);
      }) ?? null),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const sourceIds = recordCondition(where.sourceId).in;
        if (Array.isArray(sourceIds)) deletedDocumentSourceIds.push(...sourceIds.map(String));
        return { count: Array.isArray(sourceIds) ? sourceIds.length : 0 };
      }),
    },
    $queryRawUnsafe: queryRaw,
    $executeRawUnsafe: executeRaw,
  });
  Object.assign(prisma, {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        transactionDepth += 1;
        return await callback(prisma);
      } finally {
        transactionDepth -= 1;
        release();
      }
    }),
  });
  return {
    prisma: prisma as unknown as PrismaClient,
    state: { projects, runs, artifacts, events, images, jobs, imageCalls, documents, deletedDocumentSourceIds },
    spies: { queryRaw, executeRaw, projectDelegate, runDelegate, artifactDelegate, eventDelegate, jobDelegate, isTransactionActive: () => transactionDepth > 0 },
  };
}

function recordCondition(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function createBilling(overrides: Partial<CodexPetBilling> = {}) {
  return {
    chargeResource: vi.fn(async () => ({ charged: 200 })),
    reserveResource: vi.fn(async () => ({ reserved: 2800 })),
    settleResource: vi.fn(async () => ({ settled: 200 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [{
      resourceKey: CODEX_PET_RESOURCE_KEY,
      displayName: "Codex 桌宠",
      pricingType: "PER_UNIT" as const,
      rate: 200,
      perUnits: 1,
      enabled: true,
    }] })),
    ...overrides,
  };
}

async function createApp(prisma: PrismaClient, overrides: Partial<CodexPetRouteDeps> = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => {
    const raw = request.headers["x-test-user"];
    request.userId = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  });
  const billing = overrides.billing ?? createBilling();
  const enqueueRun = overrides.enqueueRun ?? vi.fn(async () => undefined);
  await app.register(codexPetRoutes, {
    prisma,
    billing,
    enqueueRun,
    signingSecret: "test-signing-secret-that-is-long-enough",
    publicBaseUrl: "https://api.example.test",
    now: () => new Date(NOW),
    loadArtifact: async (key: string) => Buffer.from(`bytes:${key}`),
    validateReferenceAsset: async () => true,
    subscribeRunEvents: async () => undefined,
    notifyRunEvent: async () => undefined,
    waitForSseDisconnect: async () => undefined,
    assertVisualQaReady: () => undefined,
    assertImageReady: () => undefined,
    ...overrides,
  });
  return { app, billing, enqueueRun };
}

const auth = { "x-test-user": "u1" };

describe("Codex pet routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts only a complete runner validation report", () => {
    expect(codexPetValidationPassed(completeValidationReport())).toBe(true);
    expect(codexPetValidationPassed({ ok: true, spriteVersionNumber: 2 })).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({ modelContractVersion: undefined }))).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({ modelProvenance: undefined }))).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      modelProvenance: {
        imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-codex"] },
        visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["qwen3.7-plus"], routes: ["chatgpt_model_route"] },
      },
    }))).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      modelProvenance: {
        imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-qwen-fallback"] },
        visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["chatgpt_model_route"] },
      },
    }))).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      modelProvenance: {
        imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-codex"] },
        visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol-qwen-fallback"], routes: ["chatgpt_model_route"] },
      },
    }))).toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      modelProvenance: {
        imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-codex"] },
        visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["primary_fallback"] },
      },
    }))).toBe(false);
    for (const hardGate of ["identity", "structure", "semantics", "continuity"] as const) {
      expect(codexPetValidationPassed(completeValidationReport({
        finalVisualQa: {
          pass: true,
          identity: true,
          structure: true,
          semantics: true,
          continuity: true,
          [hardGate]: false,
        },
      }))).toBe(false);
    }

    const requiredGates = [
      ["deterministic", "ok"],
      ["standardAtlasValidation", "ok"],
      ["packagedSpritesheet", "ok"],
      ["chromaDespill", "ok"],
      ["directionRegistration", "ok"],
      ["directionContinuity", "ok"],
      ["row9PreGenerationGate", "passed"],
      ["row10PreGenerationGate", "passed"],
      ["blindDirectionValidation", "ok"],
      ["finalVisualQa", "pass"],
    ] as const;
    for (const [gate, passField] of requiredGates) {
      const missing = completeValidationReport() as Record<string, unknown>;
      delete missing[gate];
      expect(codexPetValidationPassed(missing), `missing ${gate}`).toBe(false);
      expect(codexPetValidationPassed(completeValidationReport({
        [gate]: { [passField]: false },
      })), `failed ${gate}.${passField}`).toBe(false);
    }

    const semantics = completeValidationReport().directionSemantics;
    expect(codexPetValidationPassed(completeValidationReport({
      directionSemantics: semantics.slice(0, -1),
    })), "missing fixed direction").toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      directionSemantics: [...semantics.slice(0, -1), semantics[0]],
    })), "duplicate direction").toBe(false);
    expect(codexPetValidationPassed(completeValidationReport({
      directionSemantics: semantics.map((entry, index) => index === 7
        ? { ...entry, verdict: "fail" }
        : entry),
    })), "failed direction").toBe(false);
  });

  it("revalidates reference MIME, object namespace, decoded raster, and 10MB size", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#2459c7" } }).png().toBuffer();
    const asset = { id: "reference-1", userId: "u1", objectKey: "workflow/images/u1/request-1/reference.png", mime: "image/png" };
    await expect(validateCodexPetReferenceAsset(asset, async () => png)).resolves.toBe(true);
    await expect(validateCodexPetReferenceAsset({ ...asset, mime: "image/svg+xml" }, async () => png)).resolves.toBe(false);
    await expect(validateCodexPetReferenceAsset({ ...asset, objectKey: "workflow/../secret.png" }, async () => png)).resolves.toBe(false);
    await expect(validateCodexPetReferenceAsset({ ...asset, objectKey: "workflow/images/u2/request-1/reference.png" }, async () => png)).resolves.toBe(false);
    await expect(validateCodexPetReferenceAsset(asset, async () => Buffer.alloc(10 * 1024 * 1024 + 1))).resolves.toBe(false);
    await expect(validateCodexPetReferenceAsset(asset, async () => Buffer.from("not an image"))).resolves.toBe(false);
  });

  it("requires authentication and exposes the per-image planned-call price", async () => {
    const { prisma } = createPrismaMock();
    const { app } = await createApp(prisma);
    expect((await app.inject({ method: "GET", url: "/api/workflow/codex-pets/pricing" })).statusCode).toBe(401);

    const response = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/pricing", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.pricing).toMatchObject({
      resourceKey: CODEX_PET_RESOURCE_KEY,
      pricingType: "PER_UNIT",
      rate: 200,
      plannedImageCallLimit: 14,
      includedBaseCandidates: 2,
    });
    await app.close();
  });

  it("lists GPT Image 2 only and keeps legacy non-GPT projects read-only", async () => {
    const project = projectRow({
      imageModel: QWEN_IMAGE_MODEL,
      visualQaModel: CODEX_PET_BAILIAN_VISUAL_QA_MODEL,
    });
    const { prisma, state } = createPrismaMock({ projects: [project] });
    const billing = createBilling({
      listEnabledModels: vi.fn(async () => ({ data: [
        { model: CODEX_PET_BAILIAN_VISUAL_QA_MODEL, displayName: "Qwen3.6 Flash" },
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
        { model: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", tags: "chat,coding,vision" },
        { model: "qwen3.5-ocr", displayName: "Qwen3.5 OCR", tags: "chat,vision,ocr" },
        { model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", tags: "chat,coding,reasoning" },
        { model: "qwen3.7-plus", displayName: "Qwen3.7 Plus" },
        { model: "text-embedding-v4", displayName: "Text Embedding V4" },
        { model: QWEN_IMAGE_MODEL, displayName: "Qwen Image 2.0 Pro" },
      ] })),
    });
    const { app } = await createApp(prisma, { billing });

    const catalog = await app.inject({
      method: "GET",
      url: "/api/workflow/codex-pets/models",
      headers: auth,
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data).toEqual({
      visualModels: [
        { model: CODEX_PET_BAILIAN_VISUAL_QA_MODEL, displayName: "Qwen3.6 Flash" },
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
        { model: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" },
      ],
      imageModels: [
        { model: GPT_IMAGE_MODEL, displayName: "GPT Image 2" },
      ],
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/start`,
      headers: { ...auth, "idempotency-key": "selected-model-run-1" },
      payload: { idempotencyKey: "selected-model-run-1" },
    });
    expect(started.statusCode).toBe(409);
    expect(state.runs).toHaveLength(0);
    await app.close();

    const qwen37Project = projectRow({ id: "project-qwen37", visualQaModel: "qwen3.7-plus", qualityInspectionEnabled: true });
    const { prisma: qwen37Prisma, state: qwen37State } = createPrismaMock({ projects: [qwen37Project] });
    const qwen37Billing = createBilling({
      listEnabledModels: vi.fn(async () => ({ data: [
        { model: "qwen3.7-plus", displayName: "Qwen3.7 Plus" },
        { model: CODEX_PET_BAILIAN_VISUAL_QA_MODEL, displayName: "Qwen3.6 Flash" },
      ] })),
    });
    const { app: qwen37App } = await createApp(qwen37Prisma, { billing: qwen37Billing });
    const rejected = await qwen37App.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${qwen37Project.id}/start`,
      headers: { ...auth, "idempotency-key": "qwen37-blocked-run-1" },
      payload: { idempotencyKey: "qwen37-blocked-run-1" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain("模型广场");
    expect(qwen37State.runs).toHaveLength(0);
    expect(qwen37Billing.chargeResource).not.toHaveBeenCalled();
    await qwen37App.close();
  });

  it("keeps a legacy read-only archive viewable while rejecting every mutating entrypoint", async () => {
    const project = projectRow({
      status: "legacy_read_only",
      latestRunId: "run-archive",
      imageModel: GPT_IMAGE_MODEL,
    });
    const run = runRow({
      id: "run-archive",
      status: "legacy_read_only",
      progressStage: "legacy_read_only",
      projectId: project.id,
    });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run] });
    const { app, billing, enqueueRun } = await createApp(prisma);

    const detail = await app.inject({ method: "GET", url: `/api/workflow/codex-pets/projects/${project.id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.detail.project.status).toBe("legacy_read_only");

    const update = await app.inject({ method: "PATCH", url: `/api/workflow/codex-pets/projects/${project.id}`, headers: auth, payload: { name: "不能修改" } });
    const start = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/start`,
      headers: { ...auth, "idempotency-key": "read-only-start-0001" },
      payload: { idempotencyKey: "read-only-start-0001" },
    });
    const cancel = await app.inject({ method: "POST", url: `/api/workflow/codex-pets/projects/${project.id}/runs/${run.id}/cancel`, headers: auth });
    const remove = await app.inject({ method: "DELETE", url: `/api/workflow/codex-pets/projects/${project.id}`, headers: auth });

    for (const response of [update, start, remove]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("只读");
    }
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error).toContain("已经结束");
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]!.status).toBe("legacy_read_only");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects start before creating a run or charging when the package is disabled", async () => {
    const { prisma, state } = createPrismaMock({ projects: [projectRow()] });
    const billing = createBilling({
      listResourcePrices: vi.fn(async () => ({ data: [{
        resourceKey: CODEX_PET_RESOURCE_KEY,
        displayName: "Codex 桌宠",
        pricingType: "PER_UNIT" as const,
        rate: 200,
        perUnits: 1,
        enabled: false,
      }] })),
    });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "disabled-package-key" },
      payload: { idempotencyKey: "disabled-package-key" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Codex 桌宠套餐当前已停用" });
    expect(state.runs).toHaveLength(0);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("checks the visual route only when optional AI quality inspection is enabled", async () => {
    const { prisma, state } = createPrismaMock({ projects: [projectRow({ qualityInspectionEnabled: true })] });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, {
      billing,
      enqueueRun,
      assertVisualQaReady: () => { throw new Error("gpt-5.6-sol route missing"); },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "gpt-route-missing-key" },
      payload: { idempotencyKey: "gpt-route-missing-key" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("GPT-5.6");
    expect(state.runs).toHaveLength(0);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects start before creating a run or charging when GPT Image edits are unavailable", async () => {
    const { prisma, state } = createPrismaMock({ projects: [projectRow()] });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, {
      billing,
      enqueueRun,
      assertImageReady: () => { throw new Error("GPT Image edit route missing"); },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "gpt-image-route-missing-key" },
      payload: { idempotencyKey: "gpt-image-route-missing-key" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("GPT 生图");
    expect(state.runs).toHaveLength(0);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates idempotent drafts, validates reference ownership, and enforces editable states", async () => {
    const reference = {
      id: "ref-owned",
      userId: "u1",
      objectKey: "workflow/images/u1/ref.png",
      mime: "image/png",
      originalUrl: "/private/ref.png",
      thumbnailUrl: "/private/ref-thumb.png",
      createdAt: new Date(NOW),
    };
    const oversizedReference = { ...reference, id: "ref-too-large", objectKey: "workflow/images/u1/too-large.png" };
    const activeContentReference = { ...reference, id: "ref-svg", objectKey: "workflow/images/u1/ref.svg", mime: "image/svg+xml" };
    const validateReferenceAsset = vi.fn(async (asset: { readonly id: string }) => asset.id !== oversizedReference.id);
    const { prisma, state } = createPrismaMock({ images: [reference, oversizedReference, activeContentReference] });
    const { app } = await createApp(prisma, { validateReferenceAsset });
    const payload = {
      name: "像素狐",
      prompt: "橙色狐狸",
      actionPrompts: { waving: "挥手时开心地眨一下眼" },
      stylePreset: "pixel",
      referenceAssetIds: [reference.id],
      idempotencyKey: "draft-key-0001",
    };
    const first = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects", headers: auth, payload });
    const second = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects", headers: auth, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.project.id).toBe(second.json().data.project.id);
    expect(first.json().data.project.actionPrompts).toEqual({ waving: "挥手时开心地眨一下眼" });
    expect(state.projects).toHaveLength(1);

    for (const actionPrompts of [
      { dancing: "unknown action" },
      { idle: "x".repeat(501) },
      { idle: "x".repeat(500), "running-right": "x".repeat(500), waving: "x".repeat(500), jumping: "x".repeat(500), failed: "x".repeat(500), waiting: "x".repeat(500), running: "x".repeat(500), review: "x".repeat(500), look: "x".repeat(500) },
    ]) {
      const invalidActionPrompts = await app.inject({
        method: "POST",
        url: "/api/workflow/codex-pets/projects",
        headers: auth,
        payload: { name: "动作提示词非法", prompt: "角色", actionPrompts },
      });
      expect(invalidActionPrompts.statusCode).toBe(400);
    }

    const invalidReference = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects",
      headers: auth,
      payload: { name: "越权", referenceAssetIds: ["other-user-reference"] },
    });
    expect(invalidReference.statusCode).toBe(400);

    const invalidBytes = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects",
      headers: auth,
      payload: { name: "过大参考图", referenceAssetIds: [oversizedReference.id], idempotencyKey: "draft-key-large-1" },
    });
    expect(invalidBytes.statusCode).toBe(400);
    const activeContent = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects",
      headers: auth,
      payload: { name: "SVG 参考图", referenceAssetIds: [activeContentReference.id], idempotencyKey: "draft-key-svg-001" },
    });
    expect(activeContent.statusCode).toBe(400);
    expect(validateReferenceAsset).not.toHaveBeenCalledWith(expect.objectContaining({ id: activeContentReference.id }));

    state.projects[0]!.status = "base_generating";
    const locked = await app.inject({
      method: "PATCH",
      url: `/api/workflow/codex-pets/projects/${state.projects[0]!.id}`,
      headers: auth,
      payload: { name: "不应修改" },
    });
    expect(locked.statusCode).toBe(409);
    await app.close();
  });

  it("applies edits made during base review to the run snapshot and regenerates stale candidates", async () => {
    const project = projectRow({ status: "awaiting_base_review", latestRunId: "run-1" });
    const run = runRow({
      status: "awaiting_base_review",
      progressStage: "awaiting_base_review",
      progressPercent: 15,
      inputSnapshot: {
        name: "代码狐",
        description: "旧描述",
        prompt: "旧提示词",
        stylePreset: "pixel",
        styleNotes: "",
        referenceAssetIds: [],
        autoContinue: false,
      },
      colorKey: "#00ff00",
    });
    const candidates = [
      artifactRow({ id: "candidate-old-1" }),
      artifactRow({ id: "candidate-old-2", createdAt: new Date("2026-07-17T10:03:00.000Z") }),
    ];
    const jobs = ["base-candidate-1", "base-candidate-2", "base-selection"].map((key, index) => ({
      id: `job-${index + 1}`,
      projectId: "project-1",
      runId: "run-1",
      userId: "u1",
      key,
      status: "completed",
      attempt: 1,
      inputArtifactIds: ["old-input"],
      outputArtifactIds: ["old-output"],
      output: { old: true },
      error: null,
      workerId: null,
      startedAt: new Date(NOW),
      completedAt: new Date(NOW),
    }));
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: candidates, jobs });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow/codex-pets/projects/project-1",
      headers: auth,
      payload: {
        description: "新描述",
        prompt: "带星形胸针的橙色狐狸",
        actionPrompts: { jumping: "起跳时双耳竖起" },
        stylePreset: "plush",
        autoContinue: true,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(state.projects[0]).toMatchObject({ status: "base_generating", description: "新描述", stylePreset: "plush" });
    expect(state.runs[0]).toMatchObject({
      status: "base_generating",
      colorKey: null,
      autoContinue: true,
      selectedBaseArtifactId: null,
      inputSnapshot: expect.objectContaining({
        description: "新描述",
        prompt: "带星形胸针的橙色狐狸",
        actionPrompts: { jumping: "起跳时双耳竖起" },
        stylePreset: "plush",
        autoContinue: true,
      }),
    });
    expect(state.artifacts.every((artifact) => artifact.status === "superseded")).toBe(true);
    expect(state.jobs.every((job) => job.status === "queued" && job.attempt === 0)).toBe(true);
    expect(enqueueRun).toHaveBeenCalledWith("run-1");
    expect(state.events.at(-1)).toMatchObject({ type: "stage.started", payload: { projectInputUpdated: true } });
    await app.close();
  });

  it("serializes project details with runs, candidate artifacts, jobs, and owned references", async () => {
    const project = projectRow({ referenceAssetIds: ["ref-1"], latestRunId: "run-1", status: "awaiting_base_review" });
    const run = runRow({ status: "awaiting_base_review" });
    const artifact = artifactRow();
    const image = {
      id: "ref-1",
      userId: "u1",
      objectKey: "workflow/images/u1/ref.png",
      mime: "image/png",
      originalUrl: "/ref.png",
      thumbnailUrl: "/ref-thumb.png",
      createdAt: new Date(NOW),
    };
    const { prisma } = createPrismaMock({ projects: [project], runs: [run], artifacts: [artifact], images: [image] });
    const { app } = await createApp(prisma, { artifactPreviewUrl: (item) => `/preview/${item.id}` });
    const response = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.detail).toMatchObject({
      project: { id: "project-1", referenceAssets: [{ id: "ref-1" }] },
      latestRun: { id: "run-1", status: "awaiting_base_review" },
      artifacts: [{ id: "artifact-1", previewUrl: "/preview/artifact-1" }],
    });
    await app.close();
  });

  it("publishes only an owned recovery source run in project details", async () => {
    const project = projectRow({ latestRunId: "run-recovery", status: "ready" });
    const source = runRow({ id: "run-source", status: "failed", progressStage: "failed" });
    const recovery = runRow({
      id: "run-recovery",
      status: "ready",
      progressStage: "ready",
      inputSnapshot: {
        recovery: {
          schemaVersion: "codex-pet-recovery-v1",
          sourceRunId: source.id,
        },
      },
    });
    const invalidRecovery = runRow({
      id: "run-invalid-recovery",
      status: "ready",
      progressStage: "ready",
      inputSnapshot: {
        recovery: {
          schemaVersion: "codex-pet-recovery-v1",
          sourceRunId: "run-from-another-project",
        },
      },
    });
    const foreignSource = runRow({
      id: "run-from-another-project",
      projectId: "project-other",
      userId: "u2",
    });
    const { prisma } = createPrismaMock({
      projects: [project],
      runs: [recovery, source, invalidRecovery, foreignSource],
    });
    const { app } = await createApp(prisma);

    const response = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });

    expect(response.statusCode).toBe(200);
    const detail = response.json().data.detail as {
      latestRun: { recoverySourceRunId: string | null };
      runs: Array<{ id: string; recoverySourceRunId: string | null }>;
    };
    expect(detail.latestRun.recoverySourceRunId).toBe("run-source");
    expect(detail.runs.find((run) => run.id === "run-source")?.recoverySourceRunId).toBeNull();
    expect(detail.runs.find((run) => run.id === "run-invalid-recovery")?.recoverySourceRunId).toBeNull();
    expect(detail.runs.some((run) => run.id === foreignSource.id)).toBe(false);
    await app.close();
  });

  it("issues 15-minute signed preview capabilities only from an owned project and binds them to the artifact id", async () => {
    const ownedProject = projectRow();
    const otherProject = projectRow({ id: "project-other", userId: "u2", name: "别人的桌宠" });
    const ownedArtifact = artifactRow({ id: "preview-owned", objectKey: "workflow/codex-pets/u1/project-1/run-1/preview.png", mime: "image/png" });
    const otherArtifact = artifactRow({
      id: "preview-other",
      projectId: "project-other",
      runId: "run-other",
      userId: "u2",
      objectKey: "workflow/codex-pets/u2/project-other/run-other/preview.png",
      mime: "image/png",
    });
    const zipArtifact = artifactRow({ id: "private-zip", kind: "package", mime: "application/zip", width: null, height: null });
    const { prisma } = createPrismaMock({ projects: [ownedProject, otherProject], artifacts: [ownedArtifact, otherArtifact, zipArtifact] });
    const loadArtifact = vi.fn(async (key: string) => Buffer.from(`stored:${key}`));
    const { app } = await createApp(prisma, { loadArtifact });

    const detail = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(detail.statusCode).toBe(200);
    const serialized = detail.json().data.detail.artifacts as Array<{ id: string; previewUrl: string | null }>;
    const previewUrl = serialized.find((artifact) => artifact.id === "preview-owned")?.previewUrl;
    expect(previewUrl).toContain("purpose=preview");
    expect(previewUrl).toMatch(/^\/api\/public\/codex-pets\/artifacts\/preview-owned\?/);
    expect(serialized.find((artifact) => artifact.id === "private-zip")?.previewUrl).toBeNull();
    const parsed = new URL(previewUrl!, "https://api.example.test");
    expect(Number(parsed.searchParams.get("exp")) - Math.floor(NOW.getTime() / 1_000)).toBe(15 * 60);

    const fetched = await app.inject({ method: "GET", url: `${parsed.pathname}${parsed.search}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload).toEqual(Buffer.from("stored:workflow/codex-pets/u1/project-1/run-1/preview.png"));

    const swappedPath = parsed.pathname.replace("preview-owned", "preview-other");
    const swapped = await app.inject({ method: "GET", url: `${swappedPath}${parsed.search}` });
    expect(swapped.statusCode).toBe(401);
    expect(loadArtifact).toHaveBeenCalledTimes(1);

    const crossUserDetail = await app.inject({
      method: "GET",
      url: "/api/workflow/codex-pets/projects/project-1",
      headers: { "x-test-user": "u2" },
    });
    expect(crossUserDetail.statusCode).toBe(404);
    await app.close();
  });

  it("does not issue or serve inline SVG previews through the signed public endpoint", async () => {
    const project = projectRow();
    const svg = artifactRow({
      id: "preview-svg",
      mime: "image/svg+xml",
      objectKey: "workflow/codex-pets/u1/project-1/run-1/preview.svg",
    });
    const { prisma } = createPrismaMock({ projects: [project], artifacts: [svg] });
    const loadArtifact = vi.fn(async () => Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"));
    const { app } = await createApp(prisma, { loadArtifact });
    const detail = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.detail.artifacts.find((item: { id: string }) => item.id === "preview-svg").previewUrl).toBeNull();

    const signed = signCodexPetArtifact("preview-svg", Math.floor(NOW.getTime() / 1_000) + 300, "test-signing-secret-that-is-long-enough", "codex-pet-preview");
    const response = await app.inject({
      method: "GET",
      url: `/api/public/codex-pets/artifacts/preview-svg?exp=${Math.floor(NOW.getTime() / 1_000) + 300}&sig=${encodeURIComponent(signed)}&purpose=preview`,
    });
    expect(response.statusCode).toBe(404);
    expect(loadArtifact).not.toHaveBeenCalled();
    await app.close();
  });

  it("serializes concurrent starts per user, reserves fourteen calls once, and re-enqueues idempotent retries", async () => {
    const project1 = projectRow({ actionPrompts: { jumping: "跳跃时保持微笑" } });
    const project2 = projectRow({ id: "project-2", name: "第二只" });
    const { prisma, state, spies } = createPrismaMock({ projects: [project1, project2] });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });
    const headers = { ...auth, "idempotency-key": "start-key-0001" };

    const [first, duplicate] = await Promise.all([
      app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/start", headers, payload: { idempotencyKey: "start-key-0001" } }),
      app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/start", headers, payload: { idempotencyKey: "start-key-0001" } }),
    ]);
    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([200, 202]);
    expect(state.runs).toHaveLength(1);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: `codex-pet:run:${state.runs[0]!.id}:planned-images`,
      userId: "u1",
      resourceKey: CODEX_PET_RESOURCE_KEY,
      units: 14,
    });
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    expect(spies.executeRaw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtext($1))", "codex-pet:u1");
    expect(state.runs[0]!.id).toBe(deriveCodexPetRunId("u1", "project-1", "start-key-0001"));
    expect(state.runs[0]!.inputSnapshot).toMatchObject({
      requestedModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
      qualityInspectionEnabled: false,
      billingMode: "per_image_call_v1",
      plannedImageCallLimit: 14,
      perImageCallPoints: 200,
      actionPrompts: { jumping: "跳跃时保持微笑" },
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-2/start",
      headers: { ...auth, "idempotency-key": "start-key-0002" },
      payload: { idempotencyKey: "start-key-0002" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("keeps a reserved queued run retryable when BullMQ is temporarily unavailable", async () => {
    const { prisma, state } = createPrismaMock({ projects: [projectRow()] });
    const billing = createBilling();
    const enqueueRun = vi.fn()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });
    const request = {
      method: "POST" as const,
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "start-key-retry" },
      payload: { idempotencyKey: "start-key-retry" },
    };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ retryable: true, runId: state.runs[0]!.id });
    const recovered = await app.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("continues the same GPT project after a base-candidate 429 without rewriting the settled source run", async () => {
    const project = projectRow({ status: "failed", latestRunId: "run-source" });
    const source = runRow({
      id: "run-source",
      idempotencyKey: "source-start-key",
      status: "failed",
      progressStage: "failed",
      progressPercent: 10,
      progressMessage: "上游 429",
      error: "上游 429",
      billingOperationId: "codex-pet:run:run-source:planned-images",
      billingMode: "per_image_call_v1",
      billingResourceKey: CODEX_PET_RESOURCE_KEY,
      billingReservedUnits: 14,
      billingSettledUnits: 2,
      billingReservedPoints: 2_800,
      billingSettledPoints: 400,
      billingSettlementStatus: "settled",
      billingChargeStatus: "reserved",
      qualityInspectionEnabled: false,
      imageGenerationCallCount: 2,
      plannedImageCallLimit: 14,
      hasSuccessfulImage: true,
      actualModels: ["gpt-image-2-codex"],
      workerId: null,
      completedAt: new Date(NOW),
      inputSnapshot: {
        requestedModel: "gpt-image-2",
        qualityInspectionEnabled: false,
        billingMode: "per_image_call_v1",
        plannedImageCallLimit: 14,
        perImageCallPoints: 200,
      },
    });
    const baseArtifact = artifactRow({
      id: "source-base-1",
      runId: source.id,
      jobId: "job-source-base-1",
      mime: "image/png",
      metadata: { actualModel: "gpt-image-2-codex" },
    });
    const jobs = [
      {
        id: "job-source-base-1",
        projectId: project.id,
        runId: source.id,
        userId: "u1",
        key: "base-candidate-1",
        kind: "base_candidate",
        status: "completed",
        dependencyKeys: [],
        attempt: 1,
        maxAttempts: 1,
        inputArtifactIds: [],
        outputArtifactIds: [baseArtifact.id],
        workerId: null,
        completedAt: new Date(NOW),
        error: null,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      },
      {
        id: "job-source-base-2",
        projectId: project.id,
        runId: source.id,
        userId: "u1",
        key: "base-candidate-2",
        kind: "base_candidate",
        status: "failed",
        dependencyKeys: [],
        attempt: 1,
        maxAttempts: 1,
        inputArtifactIds: [],
        outputArtifactIds: [],
        workerId: null,
        completedAt: new Date(NOW),
        error: "上游 429",
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      },
    ];
    const imageCalls = [
      {
        id: "source-call-1",
        projectId: project.id,
        runId: source.id,
        userId: "u1",
        jobKey: "base-candidate-1",
        logicalAttempt: 1,
        callKind: "planned",
        purpose: "base",
        requestedModel: "gpt-image-2",
        actualModel: "gpt-image-2-codex",
        operationId: "source-call-op-1",
        status: "succeeded",
        points: 200,
        sentAt: new Date(NOW),
        completedAt: new Date(NOW),
        error: null,
        createdAt: new Date(NOW),
      },
      {
        id: "source-call-2",
        projectId: project.id,
        runId: source.id,
        userId: "u1",
        jobKey: "base-candidate-2",
        logicalAttempt: 1,
        callKind: "planned",
        purpose: "base",
        requestedModel: "gpt-image-2",
        actualModel: null,
        operationId: "source-call-op-2",
        status: "failed",
        points: 200,
        sentAt: new Date(NOW),
        completedAt: new Date(NOW),
        error: "image relay 429 Concurrency limit exceeded",
        createdAt: new Date(NOW),
      },
    ];
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [source], jobs, artifacts: [baseArtifact], imageCalls });
    const billing = createBilling({ reserveResource: vi.fn(async () => ({ reserved: 2_400 })) });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });
    const request = {
      method: "POST" as const,
      url: `/api/workflow/codex-pets/projects/${project.id}/runs/${source.id}/continue-failed`,
      headers: { ...auth, "idempotency-key": "continue-base-429-0001" },
      payload: { idempotencyKey: "continue-base-429-0001" },
    };

    const first = await app.inject(request);
    const duplicate = await app.inject(request);

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(200);
    expect(state.runs).toHaveLength(2);
    expect(state.runs[0]).toMatchObject({
      id: source.id,
      status: "failed",
      billingSettlementStatus: "settled",
      billingSettledUnits: 2,
      billingSettledPoints: 400,
      imageGenerationCallCount: 2,
    });
    const continuation = state.runs[1]!;
    expect(continuation).toMatchObject({
      status: "awaiting_regeneration_approval",
      billingMode: "per_image_call_v1",
      billingReservedUnits: 12,
      billingReservedPoints: 2_400,
      billingSettlementStatus: "reserved",
      plannedImageCallLimit: 14,
      pendingImageJobKey: "base-candidate-2",
      imageGenerationCallCount: 0,
      qualityInspectionEnabled: false,
    });
    expect(continuation.inputSnapshot).toMatchObject({
      gptFailedContinuation: {
        sourceRunId: source.id,
        sourceBaseArtifactId: baseArtifact.id,
        retryJobKey: "base-candidate-2",
        sourcePlannedCallCount: 2,
        plannedCallsRemaining: 12,
      },
    });
    expect(state.jobs.find((job) => job.runId === continuation.id)).toMatchObject({
      key: "base-candidate-2",
      status: "awaiting_approval",
      attempt: 0,
      maxAttempts: 1,
    });
    expect(billing.reserveResource).toHaveBeenCalledTimes(1);
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: `codex-pet:run:${continuation.id}:planned-images`,
      userId: "u1",
      resourceKey: CODEX_PET_RESOURCE_KEY,
      units: 12,
    });
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("grants exactly one approved image call to a paused direction job", async () => {
    const project = projectRow({ status: "awaiting_direction_review", latestRunId: "run-1" });
    const run = runRow({
      status: "awaiting_direction_review",
      progressStage: "awaiting_direction_review",
      progressPercent: 72,
      pendingImageJobKey: "look-a",
      imageGenerationApprovalBudget: 0,
    });
    const job = {
      id: "job-look-a",
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      key: "look-a",
      kind: "look_row",
      status: "awaiting_approval",
      attempt: 1,
      maxAttempts: 3,
      workerId: null,
      completedAt: null,
      error: "等待用户批准",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], jobs: [job] });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/approve-next-image",
      headers: auth,
    });

    expect(response.statusCode).toBe(202);
    expect(state.runs[0]).toMatchObject({
      status: "direction_generating",
      imageGenerationApprovalBudget: 1,
      pendingImageJobKey: null,
    });
    expect(state.projects[0]).toMatchObject({ status: "direction_generating" });
    expect(state.jobs[0]).toMatchObject({ status: "queued", attempt: 1, error: null });
    expect(state.events.at(-1)).toMatchObject({ type: "image.call.approved", jobKey: "look-a" });
    expect(enqueueRun).toHaveBeenCalledOnce();
    await app.close();
  });

  it("charges and queues one extra GPT image call for an approved regeneration exactly once", async () => {
    const project = projectRow({ status: "awaiting_regeneration_approval", latestRunId: "run-1" });
    const run = runRow({
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      progressPercent: 42,
      pendingImageJobKey: "row-idle",
      billingMode: "per_image_call_v1",
      billingResourceKey: CODEX_PET_RESOURCE_KEY,
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      plannedImageCallLimit: 14,
      billingChargeStatus: "reserved",
    });
    const job = {
      id: "job-row-idle",
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      key: "row-idle",
      kind: "standard_row",
      status: "awaiting_approval",
      attempt: 1,
      maxAttempts: 1,
      workerId: null,
      completedAt: new Date(NOW),
      error: "provider timeout",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], jobs: [job] });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });
    const request = {
      method: "POST" as const,
      url: `/api/workflow/codex-pets/projects/${project.id}/runs/${run.id}/approve-next-image`,
      headers: { ...auth, "idempotency-key": "extra-idempotency-0001" },
      payload: { idempotencyKey: "extra-idempotency-0001" },
    };

    const [first, duplicate] = await Promise.all([app.inject(request), app.inject(request)]);

    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([202, 409]);
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(billing.chargeResource).toHaveBeenCalledWith({
      operationId: "codex-pet:run:run-1:image:row-idle:2:extra",
      userId: "u1",
      resourceKey: CODEX_PET_RESOURCE_KEY,
      units: 1,
    });
    expect(state.imageCalls).toMatchObject([{
      runId: run.id,
      jobKey: "row-idle",
      logicalAttempt: 2,
      callKind: "extra",
      status: "prepared",
    }]);
    expect(state.jobs[0]).toMatchObject({ status: "queued", maxAttempts: 2, error: null });
    expect(state.runs[0]).toMatchObject({ status: "direction_generating", pendingImageJobKey: null });
    expect(enqueueRun).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses a repair past the per-job extra ceiling before charging anything", async () => {
    const project = projectRow({ status: "awaiting_regeneration_approval", latestRunId: "run-1" });
    const run = runRow({
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      progressPercent: 42,
      pendingImageJobKey: "row-running-right",
      billingMode: "per_image_call_v1",
      billingResourceKey: CODEX_PET_RESOURCE_KEY,
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      plannedImageCallLimit: 14,
      billingChargeStatus: "reserved",
    });
    const job = {
      id: "job-row-running-right",
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      key: "row-running-right",
      kind: "standard_row",
      status: "awaiting_approval",
      attempt: 1,
      maxAttempts: 1 + CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT,
      workerId: null,
      completedAt: new Date(NOW),
      error: "frame-has-border-contact",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    // The 老鼠猫 run spent ten paid repairs on this one row and still failed.
    const imageCalls = Array.from({ length: CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT }, (_unused, index) => ({
      id: `spent-extra-${index}`,
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      jobKey: "row-running-right",
      logicalAttempt: index + 2,
      callKind: "extra",
      purpose: "repair",
      status: "succeeded",
      operationId: `codex-pet:run:run-1:image:row-running-right:${index + 2}:extra`,
      resourceKey: CODEX_PET_RESOURCE_KEY,
      points: 200,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }));
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], jobs: [job], imageCalls });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/runs/${run.id}/approve-next-image`,
      headers: { ...auth, "idempotency-key": "extra-over-cap-0001" },
      payload: { idempotencyKey: "extra-over-cap-0001" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      data: { extraCallBudget: { jobUsed: CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT, exhausted: "job" } },
    });
    expect(String(response.json().error)).toContain(String(CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT));
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(state.imageCalls).toHaveLength(CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT);
    expect(state.runs[0]).toMatchObject({ status: "awaiting_regeneration_approval", pendingImageJobKey: "row-running-right" });
    expect(state.jobs[0]).toMatchObject({ status: "awaiting_approval" });
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("still approves a repair when the exhausted extras were unpaid provider failures", async () => {
    const project = projectRow({ status: "awaiting_regeneration_approval", latestRunId: "run-1" });
    const run = runRow({
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      progressPercent: 42,
      pendingImageJobKey: "row-idle",
      billingMode: "per_image_call_v1",
      billingResourceKey: CODEX_PET_RESOURCE_KEY,
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      plannedImageCallLimit: 14,
      billingChargeStatus: "reserved",
    });
    const job = {
      id: "job-row-idle",
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      key: "row-idle",
      kind: "standard_row",
      status: "awaiting_approval",
      // The attempt counter advanced once per transport failure, which is
      // exactly why the budget is read from the ledger and not from here.
      attempt: 1 + CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT + 2,
      maxAttempts: 1 + CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT + 2,
      workerId: null,
      completedAt: new Date(NOW),
      error: "image relay socket hang up",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    // A refunded transport failure delivered no image, so it must not eat the
    // repair budget: look-cardinals once burned six of these in a row.
    const imageCalls = Array.from({ length: CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT + 2 }, (_unused, index) => ({
      id: `failed-extra-${index}`,
      projectId: project.id,
      runId: run.id,
      userId: "u1",
      jobKey: "row-idle",
      logicalAttempt: index + 2,
      callKind: "extra",
      purpose: "repair",
      status: "failed",
      refundStatus: "refunded",
      operationId: `codex-pet:run:run-1:image:row-idle:${index + 2}:extra`,
      resourceKey: CODEX_PET_RESOURCE_KEY,
      points: 200,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }));
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], jobs: [job], imageCalls });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/runs/${run.id}/approve-next-image`,
      headers: { ...auth, "idempotency-key": "extra-after-failures-0001" },
      payload: { idempotencyKey: "extra-after-failures-0001" },
    });

    expect(response.statusCode).toBe(202);
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(state.imageCalls.filter((call) => call.status === "prepared")).toHaveLength(1);
    expect(enqueueRun).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects a new start for a non-draft project while allowing an idempotent replay", async () => {
    const project = projectRow({ status: "ready", latestRunId: "run-ready" });
    const existing = runRow({
      id: "run-ready",
      projectId: project.id,
      status: "ready",
      idempotencyKey: "start-key-ready",
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "settled",
      billingReservedUnits: 14,
      billingSettledUnits: 14,
    });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [existing] });
    const billing = createBilling();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, enqueueRun });

    const replay = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/start`,
      headers: { ...auth, "idempotency-key": "start-key-ready" },
      payload: { idempotencyKey: "start-key-ready" },
    });
    expect(replay.statusCode).toBe(200);
    expect(billing.chargeResource).not.toHaveBeenCalled();

    const fresh = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${project.id}/start`,
      headers: { ...auth, "idempotency-key": "start-key-new" },
      payload: { idempotencyKey: "start-key-new" },
    });
    expect(fresh.statusCode).toBe(409);
    expect(state.runs).toHaveLength(1);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * A parked run is not *running*, but approving it dispatches paid image calls
   * at once. Leaving it out of the new-run block let a user start a second run and
   * then approve the parked one, putting two runs on the same upstream quota —
   * the 429 shape that killed an earlier run.
   */
  it("blocks a new run while another sits parked on approval, and names the exit", async () => {
    const parkedProject = projectRow({ id: "project-parked", status: "standard_generating", latestRunId: "run-parked" });
    const draft = projectRow({ id: "project-fresh", status: "draft", latestRunId: null });
    const parked = runRow({
      id: "run-parked",
      projectId: parkedProject.id,
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      idempotencyKey: "start-key-parked",
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      workerId: null,
    });
    const { prisma, state } = createPrismaMock({ projects: [parkedProject, draft], runs: [parked] });
    const billing = createBilling();
    const { app } = await createApp(prisma, { billing, enqueueRun: vi.fn(async () => undefined) });

    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/codex-pets/projects/${draft.id}/start`,
      headers: { ...auth, "idempotency-key": "start-key-second" },
      payload: { idempotencyKey: "start-key-second" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { readonly error: string; readonly activeRunId?: string };
    // The generic "已有正在制作" message leaves a parked run undiagnosable, since
    // from the user's side nothing appears to be happening.
    expect(body.error).toContain("等待重出图授权");
    expect(body.error).toContain("取消");
    expect(body.activeRunId).toBe("run-parked");
    expect(state.runs).toHaveLength(1);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not resurrect a legacy insufficient idempotent run", async () => {
    const originalProject = projectRow({ id: "project-1", status: "draft" });
    const insufficient = runRow({
      id: "run-insufficient",
      projectId: originalProject.id,
      idempotencyKey: "start-key-stale",
      status: "cancelled",
      progressStage: "cancelled",
      billingChargeStatus: "insufficient",
      billingPoints: 0,
      billingChargedAt: null,
      billingActivatedAt: null,
      startedAt: null,
      completedAt: new Date(NOW),
    });
    const { prisma } = createPrismaMock({ projects: [originalProject], runs: [insufficient] });
    const billing = createBilling();
    const { app } = await createApp(prisma, { billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "start-key-stale" },
      payload: { idempotencyKey: "start-key-stale" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("旧计费合同");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("retries the same per-image reservation after an insufficient balance response", async () => {
    const project = projectRow({
      status: "draft",
      prompt: "新的毛绒机器人提示词",
      stylePreset: "plush",
      autoContinue: true,
      referenceAssetIds: [],
    });
    const insufficient = runRow({
      id: "run-insufficient",
      idempotencyKey: "start-key-topup",
      status: "queued",
      progressStage: "queued",
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "insufficient",
      billingReservedUnits: 14,
      billingResourceKey: CODEX_PET_RESOURCE_KEY,
      billingOperationId: "codex-pet:run:run-insufficient:planned-images",
      billingChargeStatus: "insufficient",
      billingPoints: 0,
      billingChargedAt: null,
      billingActivatedAt: null,
      startedAt: null,
      completedAt: null,
      autoContinue: false,
      inputSnapshot: {
        name: "代码狐",
        prompt: "旧提示词",
        stylePreset: "pixel",
        autoContinue: false,
        referenceAssetIds: [],
      },
    });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [insufficient] });
    const billing = createBilling();
    const { app } = await createApp(prisma, { billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "start-key-topup" },
      payload: { idempotencyKey: "start-key-topup" },
    });

    expect(response.statusCode).toBe(200);
    expect(state.runs[0]).toMatchObject({
      billingChargeStatus: "reserved",
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
    });
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(billing.reserveResource).toHaveBeenCalledWith({
      operationId: "codex-pet:run:run-insufficient:planned-images",
      userId: "u1",
      resourceKey: CODEX_PET_RESOURCE_KEY,
      units: 14,
    });
    await app.close();
  });

  it("selects only a current-run base candidate and re-enqueues the same run", async () => {
    const project = projectRow({ status: "awaiting_base_review", latestRunId: "run-1" });
    const run = runRow({ status: "awaiting_base_review", progressPercent: 15 });
    const low = artifactRow({ id: "base-low", metadata: { qaScore: 65 } });
    const high = artifactRow({
      id: "base-high",
      metadata: { qaScore: 94 },
      expiresAt: new Date("2026-07-24T10:03:00.000Z"),
      createdAt: new Date("2026-07-17T10:03:00.000Z"),
    });
    const other = artifactRow({ id: "base-other", runId: "run-other", metadata: { qaScore: 100 } });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: [low, high, other] });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection",
      headers: auth,
      payload: { artifactId: "base-other" },
    });
    expect(invalid.statusCode).toBe(400);

    const selected = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection",
      headers: auth,
      payload: { artifactId: "base-high" },
    });
    expect(selected.statusCode).toBe(202);
    expect(selected.json().data.run).toMatchObject({
      selectedBaseArtifactId: "base-high",
      status: "standard_generating",
      progressPercent: 15,
    });
    expect(state.projects[0]!.status).toBe("standard_generating");
    expect(state.artifacts.find((artifact) => artifact.id === "base-high")?.expiresAt).toBeNull();
    expect(enqueueRun).toHaveBeenCalledWith("run-1");
    expect(state.events.at(-1)).toMatchObject({ type: "stage.started", stage: "standard_generating" });
    await app.close();
  });

  it("delegates auto-selection to the worker multimodal QA instead of guessing from artifact metadata", async () => {
    const project = projectRow({ status: "awaiting_base_review", latestRunId: "run-1" });
    const run = runRow({ status: "awaiting_base_review", progressPercent: 15, autoContinue: false });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run] });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });
    const request = {
      method: "POST" as const,
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection",
      headers: auth,
      payload: { autoSelect: true },
    };

    const selected = await app.inject(request);
    const duplicate = await app.inject(request);
    expect(selected.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(200);
    expect(selected.json().data.run).toMatchObject({
      status: "base_generating",
      autoContinue: true,
      selectedBaseArtifactId: null,
    });
    expect(state.events.at(-1)).toMatchObject({
      type: "stage.started",
      payload: { autoSelect: true },
    });
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects every base-selection mutation after project deletion has been marked", async () => {
    const project = projectRow({ status: "deleting", latestRunId: "run-1" });
    const run = runRow({ status: "awaiting_base_review", progressPercent: 15 });
    const candidate = artifactRow({ id: "base-ready" });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: [candidate] });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });

    for (const payload of [{ regenerate: true }, { autoSelect: true }, { artifactId: candidate.id }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection",
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(409);
    }
    expect(state.runs[0]).toMatchObject({ status: "awaiting_base_review", selectedBaseArtifactId: null });
    expect(state.events).toHaveLength(0);
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("regenerates both base candidates by superseding old artifacts and resetting the reusable jobs", async () => {
    const project = projectRow({ status: "awaiting_base_review", latestRunId: "run-1" });
    const run = runRow({ status: "awaiting_base_review", progressPercent: 15 });
    const candidates = [
      artifactRow({ id: "old-base-1" }),
      artifactRow({ id: "old-base-2", createdAt: new Date("2026-07-17T10:03:00.000Z") }),
    ];
    const jobs = ["base-candidate-1", "base-candidate-2", "base-selection"].map((key, index) => ({
      id: `job-${index + 1}`,
      projectId: "project-1",
      runId: "run-1",
      userId: "u1",
      key,
      kind: key === "base-selection" ? "visual_qa" : "base_candidate",
      status: "completed",
      attempt: 1,
      maxAttempts: 3,
      outputArtifactIds: [`old-output-${index + 1}`],
      error: null,
      workerId: null,
      startedAt: new Date(NOW),
      completedAt: new Date(NOW),
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }));
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: candidates, jobs });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { enqueueRun });
    const request = {
      method: "POST" as const,
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection",
      headers: auth,
      payload: { regenerate: true },
    };

    const regenerated = await app.inject(request);
    const duplicate = await app.inject(request);
    expect(regenerated.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(200);
    expect(regenerated.json().data.run).toMatchObject({
      status: "base_generating",
      selectedBaseArtifactId: null,
      progressPercent: 5,
    });
    expect(state.artifacts.every((artifact) => artifact.status === "superseded")).toBe(true);
    expect(state.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "base-candidate-1", status: "queued", attempt: 0, outputArtifactIds: [] }),
      expect.objectContaining({ key: "base-candidate-2", status: "queued", attempt: 0, outputArtifactIds: [] }),
      expect.objectContaining({ key: "base-selection", status: "queued", attempt: 0, outputArtifactIds: [] }),
    ]));
    expect(state.events.filter((event) => event.payload && (event.payload as { regenerate?: boolean }).regenerate)).toHaveLength(1);
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("cancels idempotently and refunds only before the first successful image", async () => {
    const refundable = runRow({ id: "run-refundable", billingOperationId: "codex-pet:run-refundable", hasSuccessfulImage: false });
    const nonRefundable = runRow({ id: "run-has-image", billingOperationId: "codex-pet:run-has-image", hasSuccessfulImage: true });
    const project = projectRow({ latestRunId: refundable.id, status: "queued" });
    const { prisma, state, spies } = createPrismaMock({ projects: [project], runs: [refundable, nonRefundable] });
    const refundResource = vi.fn(async () => {
      const persisted = state.runs.find((run) => run.id === "run-refundable")!;
      expect(spies.isTransactionActive()).toBe(false);
      expect(persisted).toMatchObject({ status: "cancelled", billingRefundStatus: "pending" });
      expect(state.events.map((event) => event.type)).toEqual(["run.cancelled"]);
      return { success: true };
    });
    const billing = createBilling({ refundResource });
    const requestCancellation = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, requestCancellation });

    const first = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/runs/run-refundable/cancel", headers: auth });
    const duplicate = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/runs/run-refundable/cancel", headers: auth });
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    expect(state.runs.find((run) => run.id === "run-refundable")).toMatchObject({
      status: "cancelled",
      billingRefundStatus: "refunded",
      cancelRequested: true,
    });
    expect(state.events.map((event) => event.type)).toEqual(["run.cancelled", "billing.refunded"]);

    const afterImage = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/runs/run-has-image/cancel", headers: auth });
    expect(afterImage.statusCode).toBe(200);
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    expect(requestCancellation).toHaveBeenCalledWith("run-has-image");
    await app.close();
  });

  it("does not refund a legacy base-review run even when its success flag is unset", async () => {
    const waiting = runRow({
      id: "run-base-review",
      status: "awaiting_base_review",
      progressStage: "awaiting_base_review",
      billingOperationId: "codex-pet:run-base-review",
      hasSuccessfulImage: false,
    });
    const project = projectRow({ latestRunId: waiting.id, status: "awaiting_base_review" });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [waiting] });
    const refundResource = vi.fn(async () => ({ success: true }));
    const { app } = await createApp(prisma, { billing: createBilling({ refundResource }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-base-review/cancel",
      headers: auth,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-base-review/cancel",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(refundResource).not.toHaveBeenCalled();
    expect(state.runs[0]).toMatchObject({ status: "cancelled", billingRefundStatus: "none" });
    await app.close();
  });

  it("never records a premature refund for definitely uncharged or uncertain charge intents", async () => {
    const pending = runRow({
      id: "run-pending-charge",
      billingOperationId: "codex-pet:run-pending-charge",
      billingPoints: 0,
      billingChargeStatus: "pending",
      billingChargedAt: null,
      billingActivatedAt: null,
      startedAt: null,
    });
    const uncertain = runRow({
      id: "run-uncertain-charge",
      billingOperationId: "codex-pet:run-uncertain-charge",
      billingPoints: 0,
      billingChargeStatus: "uncertain",
      billingChargedAt: null,
      billingActivatedAt: null,
      startedAt: null,
    });
    const project = projectRow({ latestRunId: pending.id, status: "queued" });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [pending, uncertain] });
    const billing = createBilling();
    const { app } = await createApp(prisma, { billing });

    const pendingResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-pending-charge/cancel",
      headers: auth,
    });
    const uncertainResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-uncertain-charge/cancel",
      headers: auth,
    });

    expect(pendingResponse.statusCode).toBe(200);
    expect(uncertainResponse.statusCode).toBe(200);
    expect(state.runs.find((item) => item.id === pending.id)).toMatchObject({
      status: "cancelled",
      billingChargeStatus: "cancelled",
      billingRefundStatus: "none",
      billingRefundedAt: null,
    });
    expect(state.runs.find((item) => item.id === uncertain.id)).toMatchObject({
      status: "cancelled",
      billingChargeStatus: "uncertain",
      billingRefundStatus: "none",
      billingRefundedAt: null,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("defers the refund decision to an active worker to avoid racing an in-flight successful image", async () => {
    const project = projectRow({ status: "base_generating", latestRunId: "run-1" });
    const run = runRow({ status: "base_generating", workerId: "worker-1", hasSuccessfulImage: false });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run] });
    const billing = createBilling();
    const requestCancellation = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { billing, requestCancellation });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/cancel",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.run).toMatchObject({
      status: "base_generating",
      cancelRequested: true,
      billingRefundedAt: null,
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect(requestCancellation).toHaveBeenCalledWith("run-1");
    expect(state.events.at(-1)).toMatchObject({ type: "run.cancellation_requested" });
    await app.close();
  });

  it("keeps a committed cancellation refund pending when the external refund fails", async () => {
    const project = projectRow({ status: "queued", latestRunId: "run-1" });
    const run = runRow({ status: "queued", workerId: null, hasSuccessfulImage: false });
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run] });
    const refundResource = vi.fn(async () => { throw new Error("billing unavailable"); });
    const { app } = await createApp(prisma, { billing: createBilling({ refundResource }) });

    const first = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/cancel", headers: auth });
    const duplicate = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/cancel", headers: auth });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(refundResource).toHaveBeenCalledOnce();
    expect(state.runs[0]).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      billingRefundStatus: "pending",
      billingRefundedAt: null,
      billingRefundRetryCount: 1,
    });
    expect(state.runs[0]!.billingRefundNextRetryAt).toBeInstanceOf(Date);
    expect(state.events.map((event) => event.type)).toEqual(["run.cancelled"]);
    await app.close();
  });

  it("lists persisted events after a cursor and SSE replays from Last-Event-ID", async () => {
    const events = [
      eventRow({ id: "event-1", sequence: 1, type: "run.queued" }),
      eventRow({ id: "event-2", sequence: 2, type: "stage.started", stage: "base_generating" }),
      eventRow({ id: "event-3", sequence: 3, type: "preview.ready", stage: "base_generating" }),
    ];
    const { prisma } = createPrismaMock({ projects: [projectRow()], runs: [runRow()], events });
    const { app } = await createApp(prisma);
    const listed = await app.inject({
      method: "GET",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/events?after=1",
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.events.map((event: { sequence: number }) => event.sequence)).toEqual([2, 3]);
    expect(listed.json().data.cursor).toBe(3);

    const stream = await app.inject({
      method: "GET",
      url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/events/stream?after=0",
      headers: { ...auth, "last-event-id": "1" },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.payload).not.toContain("id: 1\n");
    expect(stream.payload).toContain("id: 2\nevent: stage.started");
    expect(stream.payload).toContain("id: 3\nevent: preview.ready");
    await app.close();
  });

  it("keeps polling persisted events and sending heartbeats when Redis subscription fails", async () => {
    vi.useFakeTimers();
    const events = [eventRow({ id: "event-1", sequence: 1, type: "run.queued" })];
    const { prisma, state } = createPrismaMock({ projects: [projectRow()], runs: [runRow()], events });
    const subscribeRunEvents = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });
    let markStreamReady!: () => void;
    const streamReady = new Promise<void>((resolve) => { markStreamReady = resolve; });
    let disconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => { disconnect = resolve; });
    const waitForSseDisconnect = vi.fn(async () => {
      markStreamReady();
      await disconnected;
    });
    const { app } = await createApp(prisma, {
      subscribeRunEvents,
      waitForSseDisconnect,
      ssePollIntervalMs: 50,
      sseHeartbeatIntervalMs: 75,
    });

    try {
      const streamPromise = app.inject({
        method: "GET",
        url: "/api/workflow/codex-pets/projects/project-1/runs/run-1/events/stream?after=1",
        headers: auth,
      });
      await streamReady;

      state.events.push(eventRow({
        id: "event-2",
        sequence: 2,
        type: "preview.ready",
        stage: "standard_generating",
        message: "由数据库轮询补发",
      }));
      await vi.advanceTimersByTimeAsync(100);
      disconnect();

      const stream = await streamPromise;
      expect(subscribeRunEvents).toHaveBeenCalledWith("run-1", expect.any(Function));
      expect(waitForSseDisconnect).toHaveBeenCalledOnce();
      expect(stream.statusCode).toBe(200);
      expect(stream.payload).toContain(": heartbeat ");
      expect(stream.payload).toContain("id: 2\nevent: preview.ready");
      expect(stream.payload).toContain("由数据库轮询补发");
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });

  it("delivers a revalidated package before knowledge archival completes, then serves only the signed spritesheet", async () => {
    const project = projectRow({ latestRunId: "run-ready", status: "archiving", name: "代码 狐" });
    const run = runRow({
      id: "run-ready",
      status: "archiving",
      spritesheetArtifactId: "sprite-final",
      packageArtifactId: "package-final",
      previewArtifactId: "preview-final",
      validationReport: { ok: false, errors: ["legacy QA report is incomplete"] },
      knowledgeDocumentId: null,
    });
    const sprite = artifactRow({
      id: "sprite-final",
      runId: "run-ready",
      kind: "spritesheet",
      objectKey: "workflow/codex-pets/u1/project-1/run-ready/sprite.webp",
      width: 1536,
      height: 2288,
      mime: "image/webp",
    });
    const pkg = artifactRow({
      id: "package-final",
      runId: "run-ready",
      kind: "package",
      objectKey: "workflow/codex-pets/u1/project-1/run-ready/package.zip",
      width: null,
      height: null,
      mime: "application/zip",
      metadata: { petId: "code-fox" },
    });
    const { prisma } = createPrismaMock({ projects: [project], runs: [run], artifacts: [sprite, pkg] });
    const loadArtifact = vi.fn(async (key: string) => Buffer.from(`stored:${key}`));
    const { app } = await createApp(prisma, { loadArtifact });

    const install = await app.inject({ method: "POST", url: "/api/workflow/codex-pets/projects/project-1/install-link", headers: auth });
    expect(install.statusCode).toBe(200);
    const payload = install.json().data;
    expect(payload.installUrl).toContain("codex://pets/install?");
    const deepLink = new URL(payload.installUrl);
    expect(deepLink.searchParams.get("spriteVersionNumber")).toBe("2");
    expect(deepLink.searchParams.get("imageUrl")).toBe(payload.imageUrl);
    const signedImage = new URL(payload.imageUrl);

    const publicResponse = await app.inject({ method: "GET", url: `${signedImage.pathname}${signedImage.search}` });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.headers["content-type"]).toContain("image/webp");
    expect(publicResponse.rawPayload).toEqual(Buffer.from("stored:workflow/codex-pets/u1/project-1/run-ready/sprite.webp"));

    signedImage.searchParams.set("sig", `${signedImage.searchParams.get("sig")}x`);
    expect((await app.inject({ method: "GET", url: `${signedImage.pathname}${signedImage.search}` })).statusCode).toBe(401);

    const download = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1/download", headers: auth });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("code-fox.zip");
    expect(download.rawPayload).toEqual(Buffer.from("stored:workflow/codex-pets/u1/project-1/run-ready/package.zip"));
    expect((await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1/download" })).statusCode).toBe(401);
    await app.close();
  });

  it("delivers an explicitly selected historical ready run while preserving latest-run defaults", async () => {
    const project = projectRow({ latestRunId: "run-latest", status: "ready" });
    const historical = runRow({
      id: "run-historical",
      status: "ready",
      spritesheetArtifactId: "sprite-historical",
      packageArtifactId: "package-historical",
      validationReport: completeValidationReport(),
      knowledgeDocumentId: "knowledge-historical",
    });
    const latest = runRow({
      id: "run-latest",
      status: "ready",
      spritesheetArtifactId: "sprite-latest",
      packageArtifactId: "package-latest",
      validationReport: completeValidationReport(),
      knowledgeDocumentId: "knowledge-latest",
    });
    const artifacts = [
      artifactRow({ id: "sprite-historical", runId: historical.id, kind: "spritesheet", objectKey: "workflow/codex-pets/u1/project-1/run-historical/historical.webp", width: 1536, height: 2288 }),
      artifactRow({ id: "package-historical", runId: historical.id, kind: "package", objectKey: "workflow/codex-pets/u1/project-1/run-historical/historical.zip", mime: "application/zip", width: null, height: null }),
      artifactRow({ id: "sprite-latest", runId: latest.id, kind: "spritesheet", objectKey: "workflow/codex-pets/u1/project-1/run-latest/latest.webp", width: 1536, height: 2288 }),
      artifactRow({ id: "package-latest", runId: latest.id, kind: "package", objectKey: "workflow/codex-pets/u1/project-1/run-latest/latest.zip", mime: "application/zip", width: null, height: null }),
    ];
    const { prisma } = createPrismaMock({ projects: [project], runs: [historical, latest], artifacts });
    const loadArtifact = vi.fn(async (key: string) => Buffer.from(key));
    const { app } = await createApp(prisma, { loadArtifact });

    const historicalInstall = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/install-link?runId=run-historical",
      headers: auth,
    });
    expect(historicalInstall.statusCode).toBe(200);
    const historicalImage = new URL(historicalInstall.json().data.imageUrl);
    expect((await app.inject({ method: "GET", url: `${historicalImage.pathname}${historicalImage.search}` })).rawPayload)
      .toEqual(Buffer.from("workflow/codex-pets/u1/project-1/run-historical/historical.webp"));

    const historicalDownload = await app.inject({
      method: "GET",
      url: "/api/workflow/codex-pets/projects/project-1/download?runId=run-historical",
      headers: auth,
    });
    expect(historicalDownload.statusCode).toBe(200);
    expect(historicalDownload.rawPayload).toEqual(Buffer.from("workflow/codex-pets/u1/project-1/run-historical/historical.zip"));

    const latestDownload = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1/download", headers: auth });
    expect(latestDownload.statusCode).toBe(200);
    expect(latestDownload.rawPayload).toEqual(Buffer.from("workflow/codex-pets/u1/project-1/run-latest/latest.zip"));
    await app.close();
  });

  it("validates an explicit run id and retains ownership plus final-artifact gates", async () => {
    const project = projectRow({ latestRunId: "run-latest", status: "ready" });
    const selected = runRow({
      id: "run-selected",
      status: "queued",
      spritesheetArtifactId: "sprite-selected",
      packageArtifactId: "package-selected",
      validationReport: completeValidationReport(),
      knowledgeDocumentId: "knowledge-selected",
    });
    const artifacts = [
      artifactRow({ id: "sprite-selected", runId: selected.id, kind: "spritesheet", objectKey: "workflow/codex-pets/u1/project-1/run-selected/sprite.webp", width: 1536, height: 2288 }),
      artifactRow({ id: "package-selected", runId: selected.id, kind: "package", objectKey: "workflow/codex-pets/u1/project-1/run-selected/package.zip", mime: "application/zip", width: null, height: null }),
    ];
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [selected], artifacts });
    const { app } = await createApp(prisma);
    const installUrl = "/api/workflow/codex-pets/projects/project-1/install-link?runId=run-selected";

    expect((await app.inject({ method: "POST", url: `${installUrl}%2Fbad`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${installUrl}-missing`, headers: auth })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(409);

    state.runs[0]!.status = "archiving";
    state.runs[0]!.validationReport = { ok: false, spriteVersionNumber: 2 };
    state.runs[0]!.knowledgeDocumentId = null;
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(200);

    state.runs[0]!.validationReport = { ok: true };
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(200);

    state.runs[0]!.status = "failed";
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(200);
    state.runs[0]!.status = "archiving";

    const selectedSprite = state.artifacts.find((artifact) => artifact.id === "sprite-selected")!;
    const selectedPackage = state.artifacts.find((artifact) => artifact.id === "package-selected")!;
    selectedSprite.expiresAt = new Date("2026-07-24T00:00:00.000Z");
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(409);
    selectedSprite.expiresAt = null;
    selectedPackage.expiresAt = new Date("2026-07-24T00:00:00.000Z");
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(409);
    selectedPackage.expiresAt = null;
    selectedSprite.objectKey = "workflow/codex-pets/u2/project-1/run-selected/sprite.webp";
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(409);
    selectedSprite.objectKey = "workflow/codex-pets/u1/project-1/run-selected/sprite.webp";
    state.runs[0]!.userId = "u2";
    expect((await app.inject({ method: "POST", url: installUrl, headers: auth })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1/download?runId=run-selected", headers: { "x-test-user": "u2" } })).statusCode).toBe(404);
    await app.close();
  });

  it("rejects expired signed artifact URLs before touching private storage", async () => {
    const sprite = artifactRow({ id: "sprite-final", width: 1536, height: 2288 });
    const { prisma } = createPrismaMock({ artifacts: [sprite] });
    const loadArtifact = vi.fn(async () => Buffer.from("should-not-load"));
    const { app } = await createApp(prisma, { loadArtifact });
    const exp = Math.floor(NOW.getTime() / 1_000) - 1;
    const sig = signCodexPetArtifact("sprite-final", exp, "test-signing-secret-that-is-long-enough");
    const response = await app.inject({ method: "GET", url: `/api/public/codex-pets/artifacts/sprite-final?exp=${exp}&sig=${sig}` });
    expect(response.statusCode).toBe(401);
    expect(loadArtifact).not.toHaveBeenCalled();
    await app.close();
  });

  it("soft-deletes a live project, requests cancellation, and preserves its records", async () => {
    const project = projectRow({ latestRunId: "run-1", status: "base_generating" });
    const run = runRow({ status: "base_generating", workerId: "worker-1" });
    const artifact = artifactRow();
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: [artifact] });
    const requestCancellation = vi.fn(async () => undefined);
    const { app } = await createApp(prisma, { requestCancellation });

    const pending = await app.inject({ method: "DELETE", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().data).toMatchObject({ softDeleted: true, deletionPending: true, waitingForWorker: true });
    expect(requestCancellation).toHaveBeenCalledWith("run-1");
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({ status: "deleting", deletedAt: NOW, createIdempotencyKey: null });
    expect(state.runs).toHaveLength(1);
    expect(state.artifacts).toHaveLength(1);
    expect(state.deletedDocumentSourceIds).toEqual([]);

    const duplicate = await app.inject({ method: "DELETE", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(duplicate.statusCode).toBe(404);
    await app.close();
  });

  it("soft-deletes a queued project without a live worker and preserves audit data", async () => {
    const project = projectRow({ latestRunId: "run-1", status: "queued" });
    const run = runRow({ status: "queued", workerId: null, hasSuccessfulImage: false });
    const artifact = artifactRow();
    const { prisma, state } = createPrismaMock({ projects: [project], runs: [run], artifacts: [artifact] });
    const { app, billing } = await createApp(prisma);

    const response = await app.inject({ method: "DELETE", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ softDeleted: true, deletionPending: false, waitingForWorker: false });
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({ status: "deleting", deletedAt: NOW });
    expect(state.runs).toHaveLength(1);
    expect(state.artifacts).toHaveLength(1);
    expect(billing.refundResource).toHaveBeenCalledWith("codex-pet:run-1");

    const restarted = await app.inject({
      method: "POST",
      url: "/api/workflow/codex-pets/projects/project-1/start",
      headers: { ...auth, "idempotency-key": "must-not-restart-1" },
    });
    expect(restarted.statusCode).toBe(404);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("hides a soft-deleted project from history and detail without requiring a cleanup queue", async () => {
    const project = projectRow({ status: "draft" });
    const { prisma, state } = createPrismaMock({ projects: [project] });
    const { app } = await createApp(prisma);

    const response = await app.inject({ method: "DELETE", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ softDeleted: true, deletionPending: false });
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({ status: "deleting", deletedAt: NOW });

    const history = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects", headers: auth });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.projects).toEqual([]);
    const detail = await app.inject({ method: "GET", url: "/api/workflow/codex-pets/projects/project-1", headers: auth });
    expect(detail.statusCode).toBe(404);
    await app.close();
  });

  // 本插件是「逐路由挂 requireUser」而不是插件级钩子，因为
  // /api/public/codex-pets/artifacts/:artifactId 必须公开（凭签名访问，没有登录态）。
  // 逐路由的后果是每条路由各自独立：少挂一条不会有任何别的测试变红。
  // 所以下面这张表必须和生产代码里 17 处 `{ preHandler: requireUser }` 一一对应，
  // 新增需要登录的路由时同步加一行。
  const guardedRoutes: Array<[method: "GET" | "POST" | "PATCH" | "DELETE", url: string]> = [
    ["GET", "/api/workflow/codex-pets/pricing"],
    ["GET", "/api/workflow/codex-pets/models"],
    ["GET", "/api/workflow/codex-pets/projects"],
    ["POST", "/api/workflow/codex-pets/projects"],
    ["GET", "/api/workflow/codex-pets/projects/project-1"],
    ["PATCH", "/api/workflow/codex-pets/projects/project-1"],
    ["DELETE", "/api/workflow/codex-pets/projects/project-1"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/start"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/runs/run-1/continue-failed"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/runs/run-1/resume-gate-failure"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/runs/run-1/base-selection"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/runs/run-1/cancel"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/runs/run-1/approve-next-image"],
    ["GET", "/api/workflow/codex-pets/projects/project-1/runs/run-1/events"],
    ["GET", "/api/workflow/codex-pets/projects/project-1/runs/run-1/events/stream"],
    ["POST", "/api/workflow/codex-pets/projects/project-1/install-link"],
    ["GET", "/api/workflow/codex-pets/projects/project-1/download"],
  ];

  it.each(guardedRoutes)("%s %s 未登录时 401", async (method, url) => {
    const { prisma } = createPrismaMock({ projects: [projectRow()], runs: [runRow()] });
    const { app, enqueueRun } = await createApp(prisma);
    // 用 seed 好的 project/run：摘掉 preHandler 后 handler 会拿空 userId 去查库，
    // 那会返回 404 而不是 401，所以这条断言摘了守卫就一定红。
    const response = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} });
    expect(response.statusCode).toBe(401);
    // 断 body：401 在本文件里只可能来自 requireUser（公开 artifact 路由的
    // 「资源地址已失效」是另一条 URL），只断 statusCode 会给未来的改动留假绿空间。
    expect(response.json()).toEqual({ error: "未登录" });
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("公开 artifact 路由不需要登录", async () => {
    const { prisma } = createPrismaMock({ artifacts: [artifactRow({ id: "preview-svg" })] });
    const loadArtifact = vi.fn(async () => Buffer.from("preview-bytes"));
    const { app } = await createApp(prisma, { loadArtifact });
    const exp = Math.floor(NOW.getTime() / 1_000) + 300;
    const sig = signCodexPetArtifact("preview-svg", exp, "test-signing-secret-that-is-long-enough", CODEX_PET_PREVIEW_ARTIFACT_PURPOSE);
    // 不带 x-test-user：这条是全插件唯一的公开路由，
    // 有人顺手给它补上 requireUser 的话这里会变 401。
    const response = await app.inject({
      method: "GET",
      url: `/api/public/codex-pets/artifacts/preview-svg?exp=${exp}&sig=${encodeURIComponent(sig)}&purpose=preview`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("preview-bytes");
    expect(loadArtifact).toHaveBeenCalledWith(artifactRow().objectKey);
    await app.close();
  });
});
