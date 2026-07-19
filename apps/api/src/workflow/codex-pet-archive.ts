import { LOOK_DIRECTIONS, STANDARD_PET_STATES } from "@ai-assistant/codex-pet-pipeline";
import { Prisma, type Document, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { codexPetArtifactPrefix, isCodexPetArtifactObjectKeyFor } from "./codex-pet-storage.js";
import { sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";
import { codexPetValidationPassed } from "./codex-pet-delivery-validation.js";

export const CODEX_PET_KNOWLEDGE_SYSTEM_KEY = "AI_ARTIFACTS";
export const CODEX_PET_KNOWLEDGE_SOURCE_MODULE = "codex_pet";
const CODEX_PET_ARCHIVE_RASTER_MIMES = new Set(["image/png", "image/webp", "image/jpeg", "image/jpg", "image/avif"]);

export class CodexPetArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | "run_not_found"
      | "invalid_stage"
      | "archive_deleted"
      | "package_incomplete"
      | "validation_failed"
      | "source_conflict"
      | "lease_lost"
      | "cancelled",
  ) {
    super(message);
    this.name = "CodexPetArchiveError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringAt(value: JsonRecord, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function snapshotValue(snapshot: JsonRecord, key: string, fallback: string): string {
  return stringAt(snapshot, key) ?? stringAt(record(snapshot.project), key) ?? fallback;
}

function collectStringList(value: unknown, keys: ReadonlySet<string>, output: string[], depth = 0): void {
  if (depth > 5 || output.length >= 100) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStringList(entry, keys, output, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    if (keys.has(key) && Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string" && item.trim()) output.push(item.trim().slice(0, 500));
        if (output.length >= 100) return;
      }
    } else if ([
      "atlas",
      "deterministic",
      "standardAtlasValidation",
      "packagedSpritesheet",
      "chromaDespill",
      "visual",
      "multimodal",
      "final",
      "finalVisualQa",
      "blindDirectionValidation",
      "directionRegistration",
      "directionContinuity",
      "row9PreGenerationGate",
      "row10PreGenerationGate",
    ].includes(key)) {
      collectStringList(entry, keys, output, depth + 1);
    }
  }
}

function validationWarnings(report: JsonRecord): string[] {
  const warnings: string[] = [];
  collectStringList(report, new Set(["warnings", "acceptableWarnings"]), warnings);
  return [...new Set(warnings.map((warning) => sanitizeCodexPetDiagnosticText(warning, 500)))];
}

function validationErrors(report: JsonRecord): string[] {
  const errors: string[] = [];
  collectStringList(report, new Set(["errors", "failures"]), errors);
  return [...new Set(errors.map((error) => sanitizeCodexPetDiagnosticText(error, 500)))];
}

function artifactPetId(metadata: Prisma.JsonValue, fallback: string): string {
  const candidate = stringAt(record(metadata), "petId");
  return candidate?.slice(0, 128) ?? fallback;
}

function archiveText(value: string, maxLength: number): string {
  // User/model text is intentionally included in the searchable document, but
  // it must not become a channel for echoed credentials, object keys or huge
  // provider responses. Keep line breaks (useful for prompts) while stripping
  // other control characters after the shared diagnostic redaction pass.
  return sanitizeCodexPetDiagnosticText(value, maxLength).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

function archiveRasterMime(value: string): boolean {
  return CODEX_PET_ARCHIVE_RASTER_MIMES.has(value.split(";", 1)[0]!.trim().toLowerCase());
}

function archiveDocumentId(runId: string): string {
  return `codex_pet_${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

function buildArchiveContent(args: {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly stylePreset: string;
  readonly styleNotes: string;
  readonly requestedModel: string;
  readonly actualModels: readonly string[];
  readonly visualQaRequestedModel: string;
  readonly visualQaActualModels: readonly string[];
  readonly visualQaRoutes: readonly string[];
  readonly modelContractVersion: string;
  readonly warnings: readonly string[];
  readonly projectCreatedAt: Date;
  readonly runCreatedAt: Date;
}): string {
  const warnings = args.warnings.length
    ? args.warnings.map((warning) => `- ${warning}`).join("\n")
    : "- 无";
  return [
    `桌宠名称：${archiveText(args.name, 120)}`,
    `描述：${archiveText(args.description || "无", 1_000)}`,
    `用户角色提示词：${archiveText(args.prompt || "无", 4_000)}`,
    `风格预设：${archiveText(args.stylePreset, 80)}`,
    `风格补充：${archiveText(args.styleNotes || "无", 1_000)}`,
    `生成模型：请求 ${archiveText(args.requestedModel, 120)}；实际 ${args.actualModels.map((model) => archiveText(model, 120)).join("、") || archiveText(args.requestedModel, 120)}`,
    `视觉推理与质检模型：请求 ${archiveText(args.visualQaRequestedModel, 120)}；实际 ${args.visualQaActualModels.map((model) => archiveText(model, 120)).join("、") || archiveText(args.visualQaRequestedModel, 120)}`,
    `视觉推理路由：${args.visualQaRoutes.map((route) => archiveText(route, 120)).join("、")}`,
    `模型合同：${archiveText(args.modelContractVersion, 120)}`,
    "Codex v2 规格：spriteVersionNumber=2，1536×2288，8 列×11 行，单格 192×208，透明背景。",
    `标准状态：${STANDARD_PET_STATES.join("、")}`,
    `观察方向（16 个）：${LOOK_DIRECTIONS.map((direction) => `${direction}°`).join("、")}`,
    "最终验证摘要：确定性图集验证与最终视觉 QA 已通过。",
    `可接受的 QA 警告：\n${warnings}`,
    `项目创建时间：${args.projectCreatedAt.toISOString()}`,
    `运行创建时间：${args.runCreatedAt.toISOString()}`,
  ].join("\n\n");
}

/**
 * Creates the searchable AI_ARTIFACTS Document and links it to the run in one
 * transaction. The binary remains in private artifact storage; only stable
 * artifact IDs are included in metadata.
 */
export async function archiveCodexPetRun(args: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly userId: string;
  readonly projectId: string;
  /**
   * Expected runner lease. Kept optional for compatibility with maintenance
   * callers, but production workers should always provide their lease token.
   */
  readonly workerId?: string;
}): Promise<Document & { readonly documentId: string }> {
  const document = await args.prisma.$transaction(async (tx) => {
    const run = await tx.codexPetRun.findUnique({
      where: { id: args.runId, userId: args.userId, projectId: args.projectId },
      include: { project: true },
    });
    if (!run) throw new CodexPetArchiveError("Codex pet run was not found", "run_not_found");
    if (!run.project || run.project.id !== run.projectId || run.project.userId !== run.userId) {
      throw new CodexPetArchiveError("Codex pet run ownership is inconsistent", "source_conflict");
    }
    if (run.status !== "archiving" && run.status !== "ready") {
      throw new CodexPetArchiveError(`run cannot be archived from ${run.status}`, "invalid_stage");
    }
    // A user may intentionally delete the knowledge document while retaining
    // the pet. A later install/download must not recreate it. Keep this check
    // ahead of the lease gate so a completed run reports the durable deletion
    // reason instead of being mistaken for an unleased active run.
    if (run.status === "ready" && !run.knowledgeDocumentId) {
      throw new CodexPetArchiveError("knowledge archive was removed after completion", "archive_deleted");
    }
    if (run.cancelRequested) {
      throw new CodexPetArchiveError("cancelled run cannot be archived", "cancelled");
    }
    const expectedWorkerId = args.workerId?.trim();
    if (args.workerId !== undefined && !expectedWorkerId) {
      throw new CodexPetArchiveError("archive worker lease is invalid", "lease_lost");
    }
    if (!run.workerId || (expectedWorkerId && run.workerId !== expectedWorkerId)) {
      throw new CodexPetArchiveError("archive worker no longer owns the run lease", "lease_lost");
    }
    if (!run.spritesheetArtifactId || !run.packageArtifactId || !run.previewArtifactId || !run.validationReport) {
      throw new CodexPetArchiveError("final spritesheet, ZIP, preview, and validation report are required", "package_incomplete");
    }

    const report = record(run.validationReport);
    if (!codexPetValidationPassed(report)) {
      const errors = validationErrors(report);
      throw new CodexPetArchiveError(`final validation has not passed${errors[0] ? `: ${errors[0]}` : ""}`, "validation_failed");
    }

    const requiredIds = [run.spritesheetArtifactId, run.packageArtifactId, run.previewArtifactId];
    const artifacts = await tx.codexPetArtifact.findMany({
      where: {
        id: { in: requiredIds },
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        status: "ready",
      },
      select: {
        id: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        width: true,
        height: true,
        objectKey: true,
        expiresAt: true,
        metadata: true,
      },
    });
    if (artifacts.length !== requiredIds.length) {
      throw new CodexPetArchiveError("one or more final artifacts are missing or not owned by this run", "package_incomplete");
    }
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const spritesheet = byId.get(run.spritesheetArtifactId)!;
    const packageArtifact = byId.get(run.packageArtifactId)!;
    const preview = byId.get(run.previewArtifactId)!;
    if (spritesheet.kind !== "spritesheet"
      || packageArtifact.kind !== "package"
      || preview.kind !== "preview"
      || (spritesheet.mime !== "image/webp" && spritesheet.mime !== "image/png")
      || packageArtifact.mime !== "application/zip"
      || !archiveRasterMime(preview.mime)) {
      throw new CodexPetArchiveError("final artifact MIME types are invalid", "package_incomplete");
    }
    if (spritesheet.width !== 1_536 || spritesheet.height !== 2_288) {
      throw new CodexPetArchiveError("final spritesheet dimensions are invalid", "package_incomplete");
    }
    const requiredObjectPrefix = codexPetArtifactPrefix({
      userId: run.userId,
      projectId: run.projectId,
      runId: run.id,
    });
    if (artifacts.some((artifact) => artifact.sizeBytes <= 0
      || artifact.expiresAt !== null
      || !isCodexPetArtifactObjectKeyFor({
        objectKey: artifact.objectKey,
        userId: run.userId,
        projectId: run.projectId,
        runId: run.id,
      })
      || !artifact.objectKey.startsWith(requiredObjectPrefix))) {
      throw new CodexPetArchiveError("final artifacts are empty, expiring, or outside private pet storage", "package_incomplete");
    }

    const kb = await tx.knowledgeBase.upsert({
      where: { userId_systemKey: { userId: run.userId, systemKey: CODEX_PET_KNOWLEDGE_SYSTEM_KEY } },
      create: {
        ownerType: "USER",
        userId: run.userId,
        systemKey: CODEX_PET_KNOWLEDGE_SYSTEM_KEY,
        name: "AI 产物",
        description: "生图、视频、音频、小说、文章和桌宠等 AI 生成结果会自动归档到这里。",
      },
      update: {},
      select: { id: true, ownerType: true, userId: true, systemKey: true },
    });
    if (kb.ownerType !== "USER" || kb.userId !== run.userId || kb.systemKey !== CODEX_PET_KNOWLEDGE_SYSTEM_KEY) {
      throw new CodexPetArchiveError("AI 产物知识库所有权不一致", "source_conflict");
    }

    const snapshot = record(run.inputSnapshot);
    const name = snapshotValue(snapshot, "name", run.project.name);
    const description = snapshotValue(snapshot, "description", run.project.description);
    const prompt = snapshotValue(snapshot, "prompt", run.project.prompt);
    const stylePreset = snapshotValue(snapshot, "stylePreset", run.project.stylePreset);
    const styleNotes = snapshotValue(snapshot, "styleNotes", run.project.styleNotes);
    const warnings = validationWarnings(report);
    const petId = stringAt(snapshot, "petId")
      ?? stringAt(record(snapshot.project), "petId")
      ?? artifactPetId(packageArtifact.metadata, run.projectId);
    const actualModels = run.actualModels
      .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      .slice(0, 32)
      .map((model) => archiveText(model, 120));
    const requestedModel = archiveText(run.requestedModel, 120);
    const modelProvenance = record(report.modelProvenance);
    const visualQaProvenance = record(modelProvenance.visualQa);
    const visualQaRequestedModel = archiveText(stringAt(visualQaProvenance, "requestedModel") ?? "", 120);
    const visualQaActualModels = Array.isArray(visualQaProvenance.actualModels)
      ? visualQaProvenance.actualModels
          .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
          .slice(0, 16)
          .map((model) => archiveText(model, 120))
      : [];
    const visualQaRoutes = Array.isArray(visualQaProvenance.routes)
      ? visualQaProvenance.routes
          .filter((route): route is string => typeof route === "string" && route.trim().length > 0)
          .slice(0, 8)
          .map((route) => archiveText(route, 120))
      : [];
    const modelContractVersion = archiveText(stringAt(report, "modelContractVersion") ?? "", 120);
    const content = buildArchiveContent({
      name,
      description,
      prompt,
      stylePreset,
      styleNotes,
      requestedModel,
      actualModels,
      visualQaRequestedModel,
      visualQaActualModels,
      visualQaRoutes,
      modelContractVersion,
      warnings,
      projectCreatedAt: run.project.createdAt,
      runCreatedAt: run.createdAt,
    });
    const metadata: Prisma.InputJsonObject = {
      projectId: run.projectId,
      runId: run.id,
      petId,
      stylePreset,
      requestedModel,
      actualModels,
      visualQaRequestedModel,
      visualQaActualModels,
      visualQaRoutes,
      modelContractVersion,
      spriteVersionNumber: 2,
      spritesheetArtifactId: spritesheet.id,
      packageArtifactId: packageArtifact.id,
      previewArtifactId: preview.id,
      validationStatus: "passed",
      packageBytes: packageArtifact.sizeBytes,
    };
    const commonData = {
      kbId: kb.id,
      name: `Codex 桌宠 · ${name}`,
      sourceType: "ARTIFACT",
      sourceUri: null,
      content,
      mime: "application/zip",
      sizeBytes: packageArtifact.sizeBytes,
      sourceModule: CODEX_PET_KNOWLEDGE_SOURCE_MODULE,
      sourceId: run.id,
      metadata,
    } as const;
    // `findUnique -> create` is not concurrency-safe: two stale deliveries can
    // both observe no document and one then raises P2002. Catching that error
    // inside a PostgreSQL transaction is also unsafe because the transaction is
    // already aborted. `createMany(skipDuplicates)` emits an atomic
    // INSERT ... ON CONFLICT DO NOTHING on PostgreSQL, after which both the
    // creator and a concurrent loser resolve the same unique source row.
    await tx.document.createMany({
      data: [{
        id: archiveDocumentId(run.id),
        ...commonData,
        status: "pending",
        attempts: 0,
      }],
      skipDuplicates: true,
    });
    const claimed = await tx.document.findUnique({
      where: {
        sourceModule_sourceId: {
          sourceModule: CODEX_PET_KNOWLEDGE_SOURCE_MODULE,
          sourceId: run.id,
        },
      },
      include: { kb: { select: { userId: true, systemKey: true } } },
    });
    if (!claimed) {
      throw new CodexPetArchiveError("artifact source could not be claimed", "source_conflict");
    }
    if (claimed.kb.userId !== run.userId || claimed.kb.systemKey !== CODEX_PET_KNOWLEDGE_SYSTEM_KEY) {
      throw new CodexPetArchiveError("artifact source is already owned by another knowledge base", "source_conflict");
    }
    const document = await tx.document.update({
      where: { id: claimed.id },
      // Preserve pending/indexing/indexed state on idempotent retries.
      data: commonData,
    });

    // Re-check cancellation and the exact lease in the write predicate. If
    // either changed after the initial read, throwing rolls the document claim
    // and update back with the rest of this transaction.
    const linked = await tx.codexPetRun.updateMany({
      where: {
        id: run.id,
        userId: args.userId,
        projectId: args.projectId,
        status: run.status,
        workerId: run.workerId,
        cancelRequested: false,
      },
      data: { knowledgeDocumentId: document.id },
    });
    if (linked.count !== 1) {
      throw new CodexPetArchiveError("archive worker lost the run lease before commit", "lease_lost");
    }
    return document;
  });
  return { ...document, documentId: document.id };
}

/** Delete archive documents/chunks for every run in a project; artifacts are separate. */
export async function deleteCodexPetProjectArchives(args: {
  readonly prisma: PrismaClient;
  readonly projectId: string;
  readonly userId: string;
}): Promise<number> {
  const runs = await args.prisma.codexPetRun.findMany({
    where: { projectId: args.projectId, userId: args.userId },
    select: { id: true },
  });
  if (!runs.length) return 0;
  const deleted = await args.prisma.document.deleteMany({
    where: {
      sourceModule: CODEX_PET_KNOWLEDGE_SOURCE_MODULE,
      sourceId: { in: runs.map((run) => run.id) },
      kb: { ownerType: "USER", userId: args.userId, systemKey: CODEX_PET_KNOWLEDGE_SYSTEM_KEY },
    },
  });
  return deleted.count;
}
