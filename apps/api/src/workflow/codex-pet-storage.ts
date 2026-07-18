import { ObjectCannedACL } from "@aws-sdk/client-s3";
import { Prisma, type CodexPetArtifact, type PrismaClient } from "@prisma/client";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import sharp from "sharp";
import {
  deleteObject,
  getObject,
  makeS3,
  putObject,
  type S3,
} from "../storage/s3.js";

export const CODEX_PET_ARTIFACT_PREFIX = "workflow/codex-pets";
export const CODEX_PET_INSTALL_SIGNATURE_TTL_MS = 30 * 60 * 1_000;

export type CodexPetArtifactPurpose = "install-spritesheet" | (string & {});

function safePathSegment(value: string, field: string): string {
  const result = value.trim().normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  if (!result || result === "." || result === "..") throw new Error(`${field} is invalid`);
  return result;
}

function safeArtifactFilename(value: string, mime: string): string {
  const raw = basename(value.trim()).normalize("NFC");
  const sanitized = raw.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
  if (sanitized && sanitized !== "." && sanitized !== "..") return sanitized.slice(0, 180);
  if (mime === "application/zip") return "pet.zip";
  if (mime === "image/webp") return "spritesheet.webp";
  if (mime === "image/png") return "artifact.png";
  return "artifact.bin";
}

export function codexPetArtifactPrefix(args: {
  readonly userId: string;
  readonly projectId: string;
  readonly runId?: string;
}): string {
  const base = `${CODEX_PET_ARTIFACT_PREFIX}/${safePathSegment(args.userId, "userId")}/${safePathSegment(args.projectId, "projectId")}`;
  return args.runId ? `${base}/${safePathSegment(args.runId, "runId")}/` : `${base}/`;
}

export function isCodexPetArtifactObjectKey(objectKey: string): boolean {
  // S3 keys are not filesystem paths, but accepting dot/empty/control
  // segments here makes a corrupted row surprisingly easy to route to an
  // object outside the row's intended namespace (and makes logs/URL handling
  // ambiguous).  Artifact keys are always generated as
  // workflow/codex-pets/<user>/<project>/<run>/<uuid>/<filename>.
  const key = objectKey.trim();
  if (key !== objectKey) return false;
  if (!key.startsWith(`${CODEX_PET_ARTIFACT_PREFIX}/`) || key.includes("\\")) return false;
  if ([...key].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  const segments = key.split("/");
  // Six segments are accepted for legacy rows that predate the per-artifact
  // UUID directory (workflow/codex-pets/<user>/<project>/<run>/<file>).
  if (segments.length < 6 || segments[0] !== "workflow" || segments[1] !== "codex-pets") return false;
  // The first two segments are the fixed namespace.  Reject empty, dot and
  // dot-dot segments everywhere else, including a trailing filename segment.
  return segments.slice(2).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Validate an artifact key against the ownership tuple persisted alongside
 * the object.  The generic namespace check above is useful at the S3 loader
 * boundary, but deletion and delivery must additionally ensure that a
 * malformed/cross-linked DB row cannot make us read or delete another
 * project's object.
 */
export function isCodexPetArtifactObjectKeyFor(args: {
  readonly objectKey: string;
  readonly userId: string;
  readonly projectId: string;
  readonly runId?: string;
}): boolean {
  if (!isCodexPetArtifactObjectKey(args.objectKey)) return false;
  try {
    return args.objectKey.startsWith(codexPetArtifactPrefix({
      userId: args.userId,
      projectId: args.projectId,
      ...(args.runId ? { runId: args.runId } : {}),
    }));
  } catch {
    return false;
  }
}

function signingSecret(explicit?: string): string {
  const secret = explicit?.trim()
    || process.env.CODEX_PET_ARTIFACT_SIGNING_SECRET?.trim()
    || process.env.SESSION_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("CODEX_PET_ARTIFACT_SIGNING_SECRET or SESSION_SECRET must be at least 32 bytes");
  }
  return secret;
}

function signaturePayload(artifactId: string, purpose: string, exp: number): string {
  return `codex-pet-artifact-v1\n${purpose}\n${artifactId}\n${exp}`;
}

export function signCodexPetArtifact(args: {
  readonly artifactId: string;
  readonly purpose: CodexPetArtifactPurpose;
  readonly expiresAt?: number;
  readonly now?: number;
  readonly secret?: string;
}): { readonly exp: number; readonly sig: string } {
  if (!args.artifactId.trim()) throw new Error("artifactId is required");
  if (!args.purpose.trim()) throw new Error("purpose is required");
  const now = args.now ?? Date.now();
  const exp = Math.trunc(args.expiresAt ?? now + CODEX_PET_INSTALL_SIGNATURE_TTL_MS);
  if (!Number.isSafeInteger(exp) || exp <= now) throw new Error("expiresAt must be a future epoch millisecond");
  const sig = createHmac("sha256", signingSecret(args.secret))
    .update(signaturePayload(args.artifactId, args.purpose, exp))
    .digest("base64url");
  return { exp, sig };
}

export function verifyCodexPetArtifactSignature(args: {
  readonly artifactId: string;
  readonly purpose: CodexPetArtifactPurpose;
  readonly exp: number;
  readonly sig: string;
  readonly now?: number;
  readonly secret?: string;
}): boolean {
  const now = args.now ?? Date.now();
  if (!args.artifactId || !args.purpose || !args.sig || !Number.isSafeInteger(args.exp) || args.exp <= now) return false;
  const expected = createHmac("sha256", signingSecret(args.secret))
    .update(signaturePayload(args.artifactId, args.purpose, args.exp))
    .digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(args.sig);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function putCodexPetArtifact(args: {
  readonly prisma: PrismaClient;
  readonly s3?: S3;
  readonly userId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly jobId?: string | null;
  readonly kind: string;
  readonly name: string;
  readonly buffer: Buffer;
  readonly mime: string;
  readonly metadata?: Prisma.InputJsonValue;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly expiresAt?: Date | null;
}): Promise<CodexPetArtifact> {
  if (!args.buffer.length) throw new Error("artifact buffer must not be empty");
  if (!args.kind.trim()) throw new Error("artifact kind is required");
  if (!args.mime.trim()) throw new Error("artifact mime is required");
  let actualWidth: number | null = null;
  let actualHeight: number | null = null;
  if (args.mime.toLowerCase().startsWith("image/")) {
    const raster = await sharp(args.buffer, { limitInputPixels: 64_000_000 }).metadata();
    if (!raster.width || !raster.height) throw new Error("image artifact has no decodable dimensions");
    // The decoded raster is authoritative. Callers may know the intended
    // geometry, but gateways and deterministic transforms can still return a
    // different size; persisting caller claims would make install/QA gates lie.
    actualWidth = raster.width;
    actualHeight = raster.height;
  }
  const s3 = args.s3 ?? makeS3();
  const id = randomUUID();
  const filename = safeArtifactFilename(args.name, args.mime);
  const objectKey = `${codexPetArtifactPrefix(args)}${id}/${filename}`;
  const checksum = createHash("sha256").update(args.buffer).digest("hex");

  // Explicit private ACL prevents bucket defaults from accidentally exposing
  // intermediate boards or final packages.
  await putObject(s3, objectKey, args.buffer, args.mime, { acl: ObjectCannedACL.private });
  try {
    return await args.prisma.codexPetArtifact.create({
      data: {
        id,
        projectId: args.projectId,
        runId: args.runId,
        userId: args.userId,
        jobId: args.jobId ?? null,
        kind: args.kind,
        name: filename,
        status: "ready",
        objectKey,
        mime: args.mime,
        sizeBytes: args.buffer.length,
        width: actualWidth,
        height: actualHeight,
        checksum,
        metadata: args.metadata ?? {},
        expiresAt: args.expiresAt ?? null,
      },
    });
  } catch (error) {
    await deleteObject(s3, objectKey).catch(() => undefined);
    throw error;
  }
}

export function createCodexPetArtifactStore(args: {
  readonly prisma: PrismaClient;
  readonly s3?: S3;
}) {
  return {
    put: (input: {
      readonly userId: string;
      readonly projectId: string;
      readonly runId: string;
      readonly jobId?: string | null;
      readonly kind: string;
      readonly name: string;
      readonly buffer: Buffer;
      readonly mime: string;
      readonly metadata?: Record<string, unknown>;
      readonly width?: number | null;
      readonly height?: number | null;
      readonly expiresAt?: Date | null;
    }) => putCodexPetArtifact({
      ...input,
      prisma: args.prisma,
      s3: args.s3,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
    }),
    load: (artifact: Pick<CodexPetArtifact, "objectKey"> | string) => loadCodexPetArtifact(artifact, args.s3 ?? makeS3()),
  };
}

export async function loadCodexPetArtifact(
  artifactOrObjectKey: Pick<CodexPetArtifact, "objectKey"> | string,
  s3: S3 = makeS3(),
): Promise<Buffer> {
  const objectKey = typeof artifactOrObjectKey === "string" ? artifactOrObjectKey : artifactOrObjectKey.objectKey;
  if (!isCodexPetArtifactObjectKey(objectKey)) throw new Error("invalid Codex pet artifact object key");
  return getObject(s3, objectKey);
}

export async function deleteCodexPetArtifact(args: {
  readonly prisma: PrismaClient;
  readonly artifactId: string;
  readonly userId?: string;
  readonly s3?: S3;
}): Promise<boolean> {
  const artifact = await args.prisma.codexPetArtifact.findFirst({
    where: { id: args.artifactId, ...(args.userId ? { userId: args.userId } : {}) },
    select: { id: true, objectKey: true, userId: true, projectId: true, runId: true },
  });
  if (!artifact) return false;
  if (!isCodexPetArtifactObjectKeyFor(artifact)) throw new Error("invalid Codex pet artifact ownership or object key");
  await deleteObject(args.s3 ?? makeS3(), artifact.objectKey);
  await args.prisma.codexPetArtifact.delete({ where: { id: artifact.id } });
  return true;
}

export async function deleteCodexPetProjectArtifacts(args: {
  readonly prisma: PrismaClient;
  readonly projectId: string;
  readonly userId: string;
  readonly s3?: S3;
}): Promise<number> {
  const artifacts = await args.prisma.codexPetArtifact.findMany({
    where: { projectId: args.projectId, userId: args.userId },
    select: { id: true, objectKey: true, userId: true, projectId: true, runId: true },
  });
  const s3 = args.s3 ?? makeS3();
  const deletedIds: string[] = [];
  const errors: unknown[] = [];
  for (const artifact of artifacts) {
    try {
      if (!isCodexPetArtifactObjectKeyFor(artifact)) throw new Error(`invalid object key ownership for artifact ${artifact.id}`);
      await deleteObject(s3, artifact.objectKey);
      deletedIds.push(artifact.id);
    } catch (error) {
      errors.push(error);
    }
  }
  if (deletedIds.length) {
    await args.prisma.codexPetArtifact.deleteMany({
      where: { id: { in: deletedIds }, projectId: args.projectId, userId: args.userId },
    });
  }
  if (errors.length) throw new AggregateError(errors, "one or more Codex pet artifacts could not be deleted (invalid ownership or storage failure)");
  return deletedIds.length;
}
