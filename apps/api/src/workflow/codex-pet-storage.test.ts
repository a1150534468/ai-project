import { ObjectCannedACL } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { makeS3 } from "../storage/s3.js";
import {
  codexPetArtifactPrefix,
  deleteCodexPetProjectArtifacts,
  loadCodexPetArtifact,
  putCodexPetArtifact,
  signCodexPetArtifact,
  verifyCodexPetArtifactSignature,
} from "./codex-pet-storage.js";

function fakeS3(responseBody = Buffer.from("stored-pet")) {
  const s3 = makeS3({
    endpoint: "https://s3.test",
    region: "test",
    bucket: "private-bucket",
    accessKey: "access",
    secretKey: "secret",
    forcePathStyle: true,
  });
  const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
  Object.assign(s3.client, {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      commands.push(command);
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: { transformToByteArray: async () => responseBody } };
      }
      return {};
    }),
  });
  return { s3, commands };
}

function artifactPrisma(options: { failCreate?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const model = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.failCreate) throw new Error("database unavailable");
      const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => rows.map(({ id, objectKey, userId, projectId, runId }) => ({
      id,
      objectKey,
      userId: userId ?? "user-1",
      projectId: projectId ?? "project-1",
      runId: runId ?? "run-1",
    }))),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (where.id.in.includes(String(rows[index]!.id))) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    }),
  };
  return { prisma: { codexPetArtifact: model } as unknown as PrismaClient, model, rows };
}

describe("Codex pet private artifact storage", () => {
  it("uploads privately and persists decoded dimensions instead of caller claims", async () => {
    const storage = fakeS3();
    const db = artifactPrisma();
    const buffer = await sharp({ create: { width: 320, height: 240, channels: 4, background: "#2459c7" } }).webp().toBuffer();
    const artifact = await putCodexPetArtifact({
      prisma: db.prisma,
      s3: storage.s3,
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
      kind: "spritesheet",
      name: "spritesheet.webp",
      buffer,
      mime: "image/webp",
      width: 1536,
      height: 2288,
      metadata: { spriteVersionNumber: 2 },
    });

    expect(artifact.objectKey).toMatch(/^workflow\/codex-pets\/user-1\/project-1\/run-1\/[0-9a-f-]+\/spritesheet\.webp$/);
    expect(artifact).toMatchObject({ mime: "image/webp", sizeBytes: buffer.length, width: 320, height: 240 });
    expect(String(artifact.checksum)).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.commands[0]).toMatchObject({
      input: {
        Bucket: "private-bucket",
        Key: artifact.objectKey,
        Body: buffer,
        ContentType: "image/webp",
        ACL: ObjectCannedACL.private,
      },
    });
  });

  it("removes an uploaded object when the artifact database insert fails", async () => {
    const storage = fakeS3();
    const db = artifactPrisma({ failCreate: true });
    const buffer = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    await expect(putCodexPetArtifact({
      prisma: db.prisma,
      s3: storage.s3,
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
      kind: "preview",
      name: "preview.png",
      buffer,
      mime: "image/png",
    })).rejects.toThrow("database unavailable");
    expect(storage.commands.map((command) => command.constructor.name)).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
  });

  it("loads only repository-owned Codex pet object keys", async () => {
    const storage = fakeS3(Buffer.from("loaded"));
    await expect(loadCodexPetArtifact("workflow/codex-pets/user/project/run/artifact/pet.webp", storage.s3))
      .resolves.toEqual(Buffer.from("loaded"));
    await expect(loadCodexPetArtifact("kb/other-user/private.txt", storage.s3))
      .rejects.toThrow("invalid Codex pet artifact object key");
    expect(storage.commands).toHaveLength(1);
  });

  it("rejects malformed namespace segments and cross-project deletion keys", async () => {
    const storage = fakeS3();
    await expect(loadCodexPetArtifact("workflow/codex-pets/user/project/run/../secret.bin", storage.s3))
      .rejects.toThrow("invalid Codex pet artifact object key");
    await expect(loadCodexPetArtifact("workflow/codex-pets/user/project/only", storage.s3))
      .rejects.toThrow("invalid Codex pet artifact object key");
    await expect(loadCodexPetArtifact(" workflow/codex-pets/user/project/run/file.png", storage.s3))
      .rejects.toThrow("invalid Codex pet artifact object key");

    const db = artifactPrisma();
    db.rows.push({
      id: "cross-owner",
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
      objectKey: "workflow/codex-pets/another-user/project-1/run-1/a/a.png",
    });
    await expect(deleteCodexPetProjectArtifacts({
      prisma: db.prisma,
      s3: storage.s3,
      userId: "user-1",
      projectId: "project-1",
    })).rejects.toThrow(/ownership/);
    expect(storage.commands).toHaveLength(0);
  });

  it("deletes all owned project objects before deleting their artifact rows", async () => {
    const storage = fakeS3();
    const db = artifactPrisma();
    db.rows.push(
      { id: "a", userId: "user-1", projectId: "project-1", runId: "run-1", objectKey: "workflow/codex-pets/user-1/project-1/run-1/a/a.png" },
      { id: "b", userId: "user-1", projectId: "project-1", runId: "run-1", objectKey: "workflow/codex-pets/user-1/project-1/run-1/b/b.zip" },
    );
    await expect(deleteCodexPetProjectArtifacts({
      prisma: db.prisma,
      s3: storage.s3,
      userId: "user-1",
      projectId: "project-1",
    })).resolves.toBe(2);
    expect(storage.commands.map((command) => command.constructor.name)).toEqual(["DeleteObjectCommand", "DeleteObjectCommand"]);
    expect(db.model.findMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", userId: "user-1" },
      select: { id: true, objectKey: true, userId: true, projectId: true, runId: true },
    });
    expect(db.rows).toHaveLength(0);
  });

  it("binds HMAC signatures to purpose, artifact and expiry", () => {
    const secret = "a-production-length-signing-secret-value";
    const signed = signCodexPetArtifact({
      artifactId: "spritesheet-1",
      purpose: "install-spritesheet",
      now: 1_000,
      expiresAt: 31_000,
      secret,
    });
    expect(verifyCodexPetArtifactSignature({
      artifactId: "spritesheet-1",
      purpose: "install-spritesheet",
      exp: signed.exp,
      sig: signed.sig,
      now: 30_999,
      secret,
    })).toBe(true);
    expect(verifyCodexPetArtifactSignature({ ...signed, artifactId: "other", purpose: "install-spritesheet", now: 2_000, secret })).toBe(false);
    expect(verifyCodexPetArtifactSignature({ ...signed, artifactId: "spritesheet-1", purpose: "download", now: 2_000, secret })).toBe(false);
    expect(verifyCodexPetArtifactSignature({ ...signed, artifactId: "spritesheet-1", purpose: "install-spritesheet", now: 31_000, secret })).toBe(false);
  });

  it("builds the documented object namespace", () => {
    expect(codexPetArtifactPrefix({ userId: "u", projectId: "p", runId: "r" }))
      .toBe("workflow/codex-pets/u/p/r/");
  });
});
