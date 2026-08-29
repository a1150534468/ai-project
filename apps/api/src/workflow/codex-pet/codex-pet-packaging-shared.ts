/**
 * codex-pet-packaging 拆分后的契约层:最终打包 Job 的常量、产物键、内部形状、四个对外契约,
 * 以及 canonical JSON / checksum 这几个叶子工具。本文件是叶子,任何一层都能安全 import。
 *
 * `canonicalJson` 的 key 排序与 15 位有效数字不是代码风格:`reportBytes` 算出的 checksum 必须
 * 等于 `codexPetCanonicalValidationReport` 落进 jsonb 的那串字节。顺序或精度一改,已完成 Job
 * 在恢复时复算 checksum 就对不上,会被判成「验证报告损坏」而整单重跑。
 *
 * `FINAL_PACKAGE_JOB_VERSION` 同时是 `FinalPackageJobOutput.version` 的字面量类型。改它等于让
 * 所有存量 Job 的 `parseJobOutput` 返回 null —— 表现是全部旧 run 从头重打包。
 *
 * `FINAL_ARTIFACT_KEYS` 的**顺序**会原样落进 Job.outputArtifactIds,不要为了美观重排。
 *
 * `CodexPetPackagingDeferredError` 必须只有这一处定义:唯一 throw 点在
 * codex-pet-packaging-job.ts 的 `markJobDeferred`,唯一 `instanceof` 判定在
 * codex-pet-runner.ts(经门面 import)。类放在叶子文件而不是跟 throw 点同住,是为了让每一层都
 * 能直接 import 到它,永远不会有人为了破依赖环去复制第二份 —— 一旦出现第二个类,`instanceof`
 * 必然失配,表现是「本可重试的打包延后」被当成硬失败,整个 run 直接终结。
 *
 * `FINAL_PACKAGE_INPUT_SCHEMA` 与 `canonicalJson` 只在本文件内使用,故意不导出。
 *
 * 依赖方向:本文件是叶子。不 import job / artifacts / run。
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { CodexPetArtifactStore } from "./codex-pet-runner.js";

export const FINAL_PACKAGE_JOB_KEY = "final-package";
export const FINAL_PACKAGE_JOB_VERSION = 1;
const FINAL_PACKAGE_INPUT_SCHEMA = "codex-pet-final-package-v1";
export const FINAL_PACKAGE_MAX_ATTEMPTS = 10;
export const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60_000;

export const FINAL_ARTIFACT_KEYS = [
  "spritesheet",
  "package",
  "preview",
  "directionQa",
  "directionBlindQa",
  "validationReport",
] as const;

export type FinalArtifactKey = (typeof FINAL_ARTIFACT_KEYS)[number];
export type CheckpointKey = "sourceAtlas" | FinalArtifactKey;

export interface ArtifactCheckpoint {
  readonly artifactId: string;
  readonly checksum: string;
  readonly kind: string;
  readonly sizeBytes: number;
}

export interface FinalPackageJobOutput {
  readonly version: typeof FINAL_PACKAGE_JOB_VERSION;
  readonly inputRevision: string;
  readonly petId: string;
  readonly displayName: string;
  readonly description: string;
  readonly report: Record<string, unknown>;
  readonly reportChecksum: string;
  readonly artifacts: Partial<Record<CheckpointKey, ArtifactCheckpoint>>;
}

export interface CodexPetFinalPackageSeed {
  readonly petId: string;
  readonly finalAtlas: Buffer;
  readonly spritesheet: Buffer;
  readonly zip: Buffer;
  readonly contactSheet: Buffer;
  readonly directionSheet: Buffer;
  readonly blindSheet: Buffer;
  readonly report: Record<string, unknown>;
  readonly inputArtifactIds?: readonly string[];
}

export interface CodexPetDurablePackagingInput {
  readonly prisma: PrismaClient;
  readonly artifacts: CodexPetArtifactStore;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId: string;
  readonly displayName: string;
  readonly description: string;
  readonly chromaKey: string;
  readonly provider: {
    readonly actualModels: readonly string[];
    readonly usage: Record<string, number>;
  };
  readonly seed?: CodexPetFinalPackageSeed;
}

export interface CodexPetDurablePackagingResult {
  readonly jobId: string;
  readonly recovered: boolean;
  readonly petId: string;
  readonly spritesheetArtifactId: string;
  readonly packageArtifactId: string;
  readonly previewArtifactId: string;
  readonly directionArtifactId: string;
  readonly blindArtifactId: string;
  readonly validationArtifactId: string;
}

export class CodexPetPackagingDeferredError extends Error {
  constructor(
    message: string,
    readonly attempt: number,
    readonly maxAttempts: number,
  ) {
    super(message);
    this.name = "CodexPetPackagingDeferredError";
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().flatMap((key) => (
      source[key] === undefined ? [] : [[key, canonicalJson(source[key])]]
    )));
  }
  // 15 significant digits is the widest decimal spelling that round trips
  // through an IEEE-754 double unambiguously, so a canonical number never
  // hands PostgreSQL a 17-digit tail that jsonb could round by one ULP.
  // Non-finite values collapse to null exactly as JSON.stringify would, so the
  // bytes we hash are always the bytes we persist.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : Number(value.toPrecision(15));
  }
  return value;
}

/**
 * The canonical projection of a report. This is what gets persisted, so the
 * checksum always covers the exact bytes in the database rather than the
 * in-memory spelling that produced them.
 */
export function codexPetCanonicalValidationReport(
  report: Record<string, unknown>,
): Prisma.InputJsonObject {
  return canonicalJson(report) as Prisma.InputJsonObject;
}

export function reportBytes(report: Record<string, unknown>): Buffer {
  // PostgreSQL jsonb does not preserve insertion order. Canonical keys keep
  // the validation checksum stable across a process/database round trip.
  return Buffer.from(`${JSON.stringify(canonicalJson(report), null, 2)}\n`, "utf8");
}

export function codexPetFinalPackageInputRevision(input: {
  readonly finalAtlas: Buffer;
  readonly report: Record<string, unknown>;
}): { readonly revision: string; readonly finalAtlasChecksum: string; readonly reportChecksum: string } {
  const finalAtlasChecksum = checksum(input.finalAtlas);
  const reportChecksum = checksum(reportBytes(input.report));
  const revision = createHash("sha256").update(JSON.stringify({
    schema: FINAL_PACKAGE_INPUT_SCHEMA,
    finalAtlasChecksum,
    reportChecksum,
  })).digest("hex");
  return { revision, finalAtlasChecksum, reportChecksum };
}
