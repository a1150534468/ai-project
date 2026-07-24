import type { PrismaClient } from "@prisma/client";
import { LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import { describe, expect, it, vi } from "vitest";
import {
  archiveCodexPetRun,
  CodexPetArchiveError,
  deleteCodexPetProjectArchives,
} from "./codex-pet-archive.js";

const ARCHIVE_SCOPE = {
  runId: "run-1",
  userId: "user-1",
  projectId: "project-1",
} as const;

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

function archiveFixture(overrides: Record<string, unknown> = {}) {
  let activeTransaction = false;
  let document: Record<string, unknown> | null = null;
  const run = {
    id: "run-1",
    projectId: "project-1",
    userId: "user-1",
    status: "archiving",
    workerId: "worker-1",
    cancelRequested: false,
    knowledgeDocumentId: null,
    spritesheetArtifactId: "sprite-1",
    packageArtifactId: "zip-1",
    previewArtifactId: "preview-1",
    validationReport: completeValidationReport({
      warnings: ["minor edge softness"],
      rawResponse: "must never be indexed",
      objectKey: "must/never/be/indexed",
    }),
    requestedModel: "gpt-image-2",
    actualModels: ["gpt-image-2-codex"],
    inputSnapshot: {
      name: "快跑小狐",
      description: "一只戴蓝围巾的小狐狸",
      prompt: "橙色小狐狸，蓝色围巾",
      stylePreset: "plush",
      styleNotes: "柔软短绒",
      petId: "quick-fox",
    },
    createdAt: new Date("2026-07-17T02:00:00.000Z"),
    project: {
      id: "project-1",
      userId: "user-1",
      name: "mutable name",
      description: "mutable description",
      prompt: "mutable prompt",
      stylePreset: "auto",
      styleNotes: "",
      createdAt: new Date("2026-07-17T01:00:00.000Z"),
    },
    ...overrides,
  };
  const artifacts = [
    { id: "sprite-1", kind: "spritesheet", mime: "image/webp", sizeBytes: 1234, width: 1536, height: 2288, objectKey: "workflow/codex-pets/user-1/project-1/run-1/sprite.webp", expiresAt: null as Date | null, metadata: {} },
    { id: "zip-1", kind: "package", mime: "application/zip", sizeBytes: 4567, width: null, height: null, objectKey: "workflow/codex-pets/user-1/project-1/run-1/package.zip", expiresAt: null as Date | null, metadata: { petId: "quick-fox" } },
    { id: "preview-1", kind: "preview", mime: "image/png", sizeBytes: 891, width: 1024, height: 1024, objectKey: "workflow/codex-pets/user-1/project-1/run-1/preview.png", expiresAt: null as Date | null, metadata: {} },
  ];
  const tx = {
    codexPetRun: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        where.id === run.id
          && where.userId === run.userId
          && where.projectId === run.projectId
          ? run
          : null
      )),
      updateMany: vi.fn(async ({ where, data }: {
        where: Record<string, unknown>;
        data: { knowledgeDocumentId: string };
      }) => {
        expect(activeTransaction).toBe(true);
        if (where.id !== run.id
          || where.userId !== run.userId
          || where.projectId !== run.projectId
          || where.status !== run.status
          || where.workerId !== run.workerId
          || where.cancelRequested !== false
          || run.cancelRequested) return { count: 0 };
        run.knowledgeDocumentId = data.knowledgeDocumentId as never;
        return { count: 1 };
      }),
      findMany: vi.fn(),
    },
    codexPetArtifact: {
      findMany: vi.fn(async () => artifacts),
    },
    knowledgeBase: {
      upsert: vi.fn(async () => ({ id: "kb-ai-artifacts", ownerType: "USER", userId: "user-1", systemKey: "AI_ARTIFACTS" })),
    },
    document: {
      findUnique: vi.fn(async () => document
        ? { ...document, kb: { userId: "user-1", systemKey: "AI_ARTIFACTS" } }
        : null),
      createMany: vi.fn(async ({ data, skipDuplicates }: {
        data: Record<string, unknown>[];
        skipDuplicates: boolean;
      }) => {
        expect(activeTransaction).toBe(true);
        expect(skipDuplicates).toBe(true);
        if (document) return { count: 0 };
        document = {
          chunkCount: 0,
          tokensUsed: 0,
          error: null,
          opId: null,
          lockedBy: null,
          lockedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data[0],
        };
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        expect(activeTransaction).toBe(true);
        document = { ...document, ...data };
        return document;
      }),
      deleteMany: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      activeTransaction = true;
      try {
        return await callback(tx);
      } finally {
        activeTransaction = false;
      }
    }),
  } as unknown as PrismaClient;
  return {
    prisma,
    tx,
    run,
    artifacts,
    getDocument: () => document,
    setDocument: (value: Record<string, unknown> | null) => { document = value; },
  };
}

describe("Codex pet AI_ARTIFACTS archive", () => {
  it("creates an idempotent private-artifact Document and links it in the same transaction", async () => {
    const fixture = archiveFixture();
    const first = await archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE });
    const second = await archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE });

    expect(second.id).toBe(first.id);
    expect(fixture.tx.document.createMany).toHaveBeenCalledTimes(2);
    expect(fixture.tx.document.update).toHaveBeenCalledTimes(2);
    expect(fixture.tx.knowledgeBase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_systemKey: { userId: "user-1", systemKey: "AI_ARTIFACTS" } },
    }));
    expect(fixture.tx.codexPetRun.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "run-1", userId: "user-1", projectId: "project-1" },
      include: { project: true },
    });
    expect(fixture.tx.codexPetRun.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "run-1",
        userId: "user-1",
        projectId: "project-1",
        status: "archiving",
        workerId: "worker-1",
        cancelRequested: false,
      },
      data: { knowledgeDocumentId: first.id },
    });

    const doc = fixture.getDocument()!;
    expect(doc).toMatchObject({
      kbId: "kb-ai-artifacts",
      name: "Codex 桌宠 · 快跑小狐",
      sourceType: "ARTIFACT",
      sourceUri: null,
      mime: "application/zip",
      sizeBytes: 4567,
      status: "pending",
      sourceModule: "codex_pet",
      sourceId: "run-1",
    });
    expect(doc.content).toContain("橙色小狐狸，蓝色围巾");
    expect(doc.content).toContain("1536×2288");
    expect(doc.content).toContain("337.5°");
    expect(doc.content).toContain("视觉推理与质检模型：请求 gpt-5.6-sol；实际 gpt-5.6-sol");
    expect(doc.content).not.toContain("must/never/be/indexed");
    expect(doc.content).not.toContain("must never be indexed");
    expect(doc.metadata).toEqual({
      projectId: "project-1",
      runId: "run-1",
      petId: "quick-fox",
      stylePreset: "plush",
      requestedModel: "gpt-image-2",
      actualModels: ["gpt-image-2-codex"],
      visualQaRequestedModel: "gpt-5.6-sol",
      visualQaActualModels: ["gpt-5.6-sol"],
      visualQaRoutes: ["chatgpt_model_route"],
      modelContractVersion: "gpt-only-v1",
      spriteVersionNumber: 2,
      spritesheetArtifactId: "sprite-1",
      packageArtifactId: "zip-1",
      previewArtifactId: "preview-1",
      validationStatus: "passed",
      packageBytes: 4567,
    });
    expect(JSON.stringify(doc.metadata)).not.toMatch(/objectKey|signedUrl|sourceUri/i);
  });

  it("recovers the same source document when a concurrent atomic create wins", async () => {
    const fixture = archiveFixture();
    fixture.tx.document.createMany.mockImplementationOnce(async () => {
      fixture.setDocument({
        id: "concurrent-document",
        kbId: "kb-ai-artifacts",
        name: "concurrent placeholder",
        sourceType: "ARTIFACT",
        sourceUri: null,
        content: "placeholder",
        mime: "application/zip",
        sizeBytes: 1,
        status: "indexing",
        error: null,
        chunkCount: 0,
        tokensUsed: 0,
        opId: null,
        sourceModule: "codex_pet",
        sourceId: "run-1",
        metadata: {},
        lockedBy: "kb-worker",
        lockedAt: new Date(),
        attempts: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { count: 0 };
    });

    const archived = await archiveCodexPetRun({
      prisma: fixture.prisma,
      ...ARCHIVE_SCOPE,
      workerId: "worker-1",
    });

    expect(archived.id).toBe("concurrent-document");
    expect(fixture.tx.document.createMany).toHaveBeenCalledOnce();
    expect(fixture.tx.document.update).toHaveBeenCalledOnce();
    expect(fixture.getDocument()).toMatchObject({
      id: "concurrent-document",
      sourceModule: "codex_pet",
      sourceId: "run-1",
      status: "indexing",
      attempts: 2,
    });
    expect(fixture.run.knowledgeDocumentId).toBe("concurrent-document");
  });

  it.each([
    {
      name: "cancelled run",
      overrides: { cancelRequested: true },
      workerId: "worker-1",
      code: "cancelled",
    },
    {
      name: "unleased run",
      overrides: { workerId: null },
      workerId: undefined,
      code: "lease_lost",
    },
    {
      name: "stale worker",
      overrides: { workerId: "worker-current" },
      workerId: "worker-stale",
      code: "lease_lost",
    },
  ])("rejects $name before creating a knowledge document", async ({ overrides, workerId, code }) => {
    const fixture = archiveFixture(overrides);

    await expect(archiveCodexPetRun({
      prisma: fixture.prisma,
      ...ARCHIVE_SCOPE,
      ...(workerId === undefined ? {} : { workerId }),
    })).rejects.toMatchObject({ code });

    expect(fixture.tx.knowledgeBase.upsert).not.toHaveBeenCalled();
    expect(fixture.tx.document.createMany).not.toHaveBeenCalled();
    expect(fixture.run.knowledgeDocumentId).toBeNull();
  });

  it("rolls back the archive link when cancellation or lease ownership changes before commit", async () => {
    const fixture = archiveFixture();
    fixture.tx.codexPetRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(archiveCodexPetRun({
      prisma: fixture.prisma,
      ...ARCHIVE_SCOPE,
      workerId: "worker-1",
    })).rejects.toMatchObject({ code: "lease_lost" } satisfies Partial<CodexPetArchiveError>);

    expect(fixture.tx.codexPetRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workerId: "worker-1",
        cancelRequested: false,
      }),
    }));
    expect(fixture.run.knowledgeDocumentId).toBeNull();
  });

  it.each([
    { userId: "another-user", projectId: "project-1" },
    { userId: "user-1", projectId: "another-project" },
  ])("rejects an archive coordinator scope that does not own the run", async (scope) => {
    const fixture = archiveFixture();

    await expect(archiveCodexPetRun({
      prisma: fixture.prisma,
      runId: "run-1",
      ...scope,
    })).rejects.toMatchObject({ code: "run_not_found" } satisfies Partial<CodexPetArchiveError>);
    expect(fixture.tx.knowledgeBase.upsert).not.toHaveBeenCalled();
    expect(fixture.tx.codexPetArtifact.findMany).not.toHaveBeenCalled();
  });

  it("archives valid final artifacts even when the detailed QA report is incomplete", async () => {
    const incompleteReport = archiveFixture({ validationReport: { ok: false, errors: ["legacy report omitted direction evidence"] } });
    await expect(archiveCodexPetRun({ prisma: incompleteReport.prisma, ...ARCHIVE_SCOPE }))
      .resolves.toMatchObject({ documentId: expect.any(String) });
    expect(incompleteReport.tx.knowledgeBase.upsert).toHaveBeenCalledOnce();

    const incomplete = archiveFixture({ previewArtifactId: null });
    await expect(archiveCodexPetRun({ prisma: incomplete.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const wrongKind = archiveFixture();
    // The fixture's transaction returns its in-memory artifacts, so mutate a
    // required artifact kind to verify that IDs cannot be pointed at a
    // different deliverable class.
    wrongKind.tx.codexPetArtifact.findMany.mockResolvedValueOnce([
      { ...wrongKind.artifacts[0]!, kind: "package" },
      wrongKind.artifacts[1]!,
      wrongKind.artifacts[2]!,
    ]);
    await expect(archiveCodexPetRun({ prisma: wrongKind.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const missingGeometry = archiveFixture();
    missingGeometry.artifacts[0]!.width = null as never;
    await expect(archiveCodexPetRun({ prisma: missingGeometry.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const activePreview = archiveFixture();
    activePreview.artifacts[2]!.mime = "image/svg+xml";
    await expect(archiveCodexPetRun({ prisma: activePreview.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const publicObject = archiveFixture();
    publicObject.artifacts[1]!.objectKey = "workflow/codex-pets/another-user/project-1/run-1/package.zip";
    await expect(archiveCodexPetRun({ prisma: publicObject.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const temporaryFinalArtifact = archiveFixture();
    temporaryFinalArtifact.artifacts[0]!.expiresAt = new Date("2026-07-24T00:00:00.000Z");
    await expect(archiveCodexPetRun({ prisma: temporaryFinalArtifact.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const mismatchedOwner = archiveFixture({
      project: {
        id: "project-1",
        userId: "another-user",
        name: "wrong owner",
        description: "",
        prompt: "",
        stylePreset: "auto",
        styleNotes: "",
        createdAt: new Date("2026-07-17T01:00:00.000Z"),
      },
    });
    await expect(archiveCodexPetRun({ prisma: mismatchedOwner.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "source_conflict" } satisfies Partial<CodexPetArchiveError>);
  });

  it("does not recreate a knowledge document intentionally deleted after ready", async () => {
    const fixture = archiveFixture({ status: "ready", knowledgeDocumentId: null });
    await expect(archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "archive_deleted" } satisfies Partial<CodexPetArchiveError>);
    expect(fixture.tx.document.createMany).not.toHaveBeenCalled();
  });

  it("redacts provider echoes from searchable validation summaries and model metadata", async () => {
    const fixture = archiveFixture({
      actualModels: ["gpt-image-2", "sk-test-secret-value"],
      validationReport: completeValidationReport({
        acceptableWarnings: [
          "provider echoed objectKey=workflow/codex-pets/user-1/project-1/run-1/private.zip",
          `raw payload ${"a".repeat(600)}`,
        ],
      }),
    });
    const archived = await archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE });
    const document = fixture.getDocument()!;
    expect(document.content).not.toContain("workflow/codex-pets/user-1/project-1/run-1/private.zip");
    expect(document.content).not.toContain("a".repeat(600));
    expect(JSON.stringify(document.metadata)).not.toContain("sk-test-secret-value");
    expect(archived.documentId).toBe(document.id);
  });

  it("deletes project archive Documents through the user-owned source relation", async () => {
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const prisma = {
      codexPetRun: { findMany: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]) },
      document: { deleteMany },
    } as unknown as PrismaClient;
    await expect(deleteCodexPetProjectArchives({ prisma, projectId: "project-1", userId: "user-1" }))
      .resolves.toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        sourceModule: "codex_pet",
        sourceId: { in: ["run-1", "run-2"] },
        kb: { ownerType: "USER", userId: "user-1", systemKey: "AI_ARTIFACTS" },
      },
    });
  });
});
