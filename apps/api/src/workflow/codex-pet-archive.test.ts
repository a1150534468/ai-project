import type { PrismaClient } from "@prisma/client";
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

function archiveFixture(overrides: Record<string, unknown> = {}) {
  let activeTransaction = false;
  let document: Record<string, unknown> | null = null;
  const run = {
    id: "run-1",
    projectId: "project-1",
    userId: "user-1",
    status: "archiving",
    knowledgeDocumentId: null,
    spritesheetArtifactId: "sprite-1",
    packageArtifactId: "zip-1",
    previewArtifactId: "preview-1",
    validationReport: {
      ok: true,
      spriteVersionNumber: 2,
      warnings: ["minor edge softness"],
      rawResponse: "must never be indexed",
      objectKey: "must/never/be/indexed",
    },
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
    { id: "sprite-1", kind: "spritesheet", mime: "image/webp", sizeBytes: 1234, width: 1536, height: 2288, objectKey: "workflow/codex-pets/user-1/project-1/run-1/sprite.webp", expiresAt: null, metadata: {} },
    { id: "zip-1", kind: "package", mime: "application/zip", sizeBytes: 4567, width: null, height: null, objectKey: "workflow/codex-pets/user-1/project-1/run-1/package.zip", expiresAt: null, metadata: { petId: "quick-fox" } },
    { id: "preview-1", kind: "preview", mime: "image/png", sizeBytes: 891, width: 1024, height: 1024, objectKey: "workflow/codex-pets/user-1/project-1/run-1/preview.png", expiresAt: null, metadata: {} },
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
      update: vi.fn(async ({ data }: { data: { knowledgeDocumentId: string } }) => {
        expect(activeTransaction).toBe(true);
        run.knowledgeDocumentId = data.knowledgeDocumentId as never;
        return run;
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        expect(activeTransaction).toBe(true);
        document = {
          chunkCount: 0,
          tokensUsed: 0,
          error: null,
          opId: null,
          lockedBy: null,
          lockedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        return document;
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
  return { prisma, tx, run, artifacts, getDocument: () => document };
}

describe("Codex pet AI_ARTIFACTS archive", () => {
  it("creates an idempotent private-artifact Document and links it in the same transaction", async () => {
    const fixture = archiveFixture();
    const first = await archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE });
    const second = await archiveCodexPetRun({ prisma: fixture.prisma, ...ARCHIVE_SCOPE });

    expect(second.id).toBe(first.id);
    expect(fixture.tx.document.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.document.update).toHaveBeenCalledTimes(1);
    expect(fixture.tx.knowledgeBase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_systemKey: { userId: "user-1", systemKey: "AI_ARTIFACTS" } },
    }));
    expect(fixture.tx.codexPetRun.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "run-1", userId: "user-1", projectId: "project-1" },
      include: { project: true },
    });
    expect(fixture.tx.codexPetRun.update).toHaveBeenLastCalledWith({
      where: { id: "run-1", userId: "user-1", projectId: "project-1" },
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
    expect(doc.content).not.toContain("must/never/be/indexed");
    expect(doc.content).not.toContain("must never be indexed");
    expect(doc.metadata).toEqual({
      projectId: "project-1",
      runId: "run-1",
      petId: "quick-fox",
      stylePreset: "plush",
      requestedModel: "gpt-image-2",
      actualModels: ["gpt-image-2-codex"],
      spriteVersionNumber: 2,
      spritesheetArtifactId: "sprite-1",
      packageArtifactId: "zip-1",
      previewArtifactId: "preview-1",
      validationStatus: "passed",
      packageBytes: 4567,
    });
    expect(JSON.stringify(doc.metadata)).not.toMatch(/objectKey|signedUrl|sourceUri/i);
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

  it("refuses to archive before all deliverables and validation have passed", async () => {
    const invalid = archiveFixture({ validationReport: { ok: false, errors: ["wrong dimensions"] } });
    await expect(archiveCodexPetRun({ prisma: invalid.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);
    expect(invalid.tx.knowledgeBase.upsert).not.toHaveBeenCalled();

    const incomplete = archiveFixture({ previewArtifactId: null });
    await expect(archiveCodexPetRun({ prisma: incomplete.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "package_incomplete" } satisfies Partial<CodexPetArchiveError>);

    const wrongVersion = archiveFixture({ validationReport: { ok: true, spriteVersionNumber: 1 } });
    await expect(archiveCodexPetRun({ prisma: wrongVersion.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

    const missingVersion = archiveFixture({ validationReport: { ok: true } });
    await expect(archiveCodexPetRun({ prisma: missingVersion.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

    const contradictoryGate = archiveFixture({
      validationReport: {
        ok: true,
        spriteVersionNumber: 2,
        packagedSpritesheet: { ok: false, errors: ["unused-cell-not-transparent"] },
      },
    });
    await expect(archiveCodexPetRun({ prisma: contradictoryGate.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

    const contradictoryStandardAtlas = archiveFixture({
      validationReport: {
        ok: true,
        spriteVersionNumber: 2,
        standardAtlasValidation: { ok: false, errors: ["idle[7]:unused-cell-not-transparent"] },
      },
    });
    await expect(archiveCodexPetRun({ prisma: contradictoryStandardAtlas.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

    const contradictoryContinuity = archiveFixture({
      validationReport: {
        ok: true,
        spriteVersionNumber: 2,
        directionContinuity: { ok: false, errors: ["empty look cell"] },
      },
    });
    await expect(archiveCodexPetRun({ prisma: contradictoryContinuity.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

    const contradictoryRegistration = archiveFixture({
      validationReport: {
        ok: true,
        spriteVersionNumber: 2,
        directionRegistration: { ok: false, errors: ["scale mismatch"] },
      },
    });
    await expect(archiveCodexPetRun({ prisma: contradictoryRegistration.prisma, ...ARCHIVE_SCOPE }))
      .rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<CodexPetArchiveError>);

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
    expect(fixture.tx.document.create).not.toHaveBeenCalled();
  });

  it("redacts provider echoes from searchable validation summaries and model metadata", async () => {
    const fixture = archiveFixture({
      actualModels: ["gpt-image-2", "sk-test-secret-value"],
      validationReport: {
        ok: true,
        spriteVersionNumber: 2,
        acceptableWarnings: [
          "provider echoed objectKey=workflow/codex-pets/user-1/project-1/run-1/private.zip",
          `raw payload ${"a".repeat(600)}`,
        ],
      },
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
