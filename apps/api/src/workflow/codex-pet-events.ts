import { getRedis } from "@ai-assistant/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

export const CODEX_PET_EVENT_TYPES = [
  "run.queued",
  "stage.started",
  "stage.completed",
  "job.started",
  "job.retrying",
  "job.completed",
  "preview.ready",
  "base.review_required",
  "validation.warning",
  "validation.failed",
  "run.repairing",
  "package.ready",
  "knowledge.archive_started",
  "knowledge.archive_completed",
  "knowledge.archive_retrying",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "billing.refunded",
] as const;

export type CodexPetEventType = (typeof CODEX_PET_EVENT_TYPES)[number];

export const CODEX_PET_RUN_STAGES = [
  "draft",
  "queued",
  "base_generating",
  "awaiting_base_review",
  "standard_generating",
  "direction_generating",
  "validating",
  "repairing",
  "packaging",
  "archiving",
  "ready",
  "failed",
  "cancelled",
] as const;

export type CodexPetRunStage = (typeof CODEX_PET_RUN_STAGES)[number];

export type CodexPetEventPublisher = Pick<Redis, "publish">;

type SanitizedJson = string | number | boolean | null | SanitizedJson[] | { [key: string]: SanitizedJson };

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "apikey",
  "authorization",
  "base64",
  "imagebase64",
  "internalsystemprompt",
  "objectkey",
  "prompt",
  "rawresponse",
  "secret",
  "signedurl",
  "sourceuri",
  "systemprompt",
  "token",
  "upstreamresponse",
]);

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function looksLikeEmbeddedBinary(value: string): boolean {
  if (/^data:[^;,]+;base64,/i.test(value)) return true;
  return value.length >= 512 && value.length % 4 === 0 && /^[a-z0-9+/=\r\n]+$/i.test(value);
}

/**
 * Sanitizes provider and infrastructure diagnostics before they are persisted
 * or sent to a browser. Upstreams occasionally echo request fields in an error
 * message, so filtering payload keys alone is not sufficient.
 */
export function sanitizeCodexPetDiagnosticText(value: string, maxLength = 4_000): string {
  let sanitized = value
    .replace(/data:[^;,\s]+;base64,[a-z0-9+/_=-]+/gi, "[redacted binary]")
    .replace(/[a-z0-9+/_=-]{512,}/gi, "[redacted binary]")
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-z0-9._-]{8,}/gi, "[redacted api key]")
    .replace(
      /("(?:api[_-]?key|authorization|base64|image[_-]?base64|internal[_-]?system[_-]?prompt|object[_-]?key|prompt|raw[_-]?response|secret|signed[_-]?url|source[_-]?uri|system[_-]?prompt|token|upstream[_-]?response)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[redacted]"',
    )
    .replace(/\bworkflow\/codex-pets\/[^\s"'`<>]+/gi, "[redacted object key]")
    .replace(/https?:\/\/[^\s"'<>]*[?&](?:sig|signature)=[^\s"'<>]+/gi, "[redacted signed url]");
  if (sanitized.length > maxLength) sanitized = sanitized.slice(0, maxLength);
  return sanitized;
}

/** Defense in depth: event callers receive only a small, JSON-safe payload. */
export function sanitizeCodexPetEventPayload(payload: Record<string, unknown>): Prisma.InputJsonObject {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): SanitizedJson | undefined => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value as null | boolean | number;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") {
      return looksLikeEmbeddedBinary(value)
        ? "[redacted binary]"
        : sanitizeCodexPetDiagnosticText(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (depth >= 6) return "[truncated]";
    if (Array.isArray(value)) {
      return value.slice(0, 100).flatMap((entry) => {
        const sanitized = visit(entry, depth + 1);
        return sanitized === undefined ? [] : [sanitized];
      });
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const result: { [key: string]: SanitizedJson } = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
        if (SENSITIVE_PAYLOAD_KEYS.has(normalizedKey(key))) continue;
        const sanitized = visit(entry, depth + 1);
        if (sanitized !== undefined) result[key] = sanitized;
      }
      return result;
    }
    return undefined;
  };

  return visit(payload, 0) as Prisma.InputJsonObject;
}

export function codexPetRunChannel(runId: string): string {
  return `codex-pet:run:${runId}`;
}

export async function appendCodexPetEvent(args: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly type: CodexPetEventType | (string & {});
  readonly stage: CodexPetRunStage | (string & {});
  readonly jobKey?: string | null;
  readonly message?: string | null;
  readonly progress?: number;
  readonly payload?: Record<string, unknown>;
  readonly redis?: CodexPetEventPublisher;
}) {
  const rawProgress = args.progress ?? 0;
  const progress = Number.isFinite(rawProgress)
    ? Math.max(0, Math.min(100, Math.round(rawProgress)))
    : 0;
  const event = await args.prisma.$transaction(async (tx) => {
    // The atomic increment serializes concurrent writers for this run. The
    // event is inserted in the same transaction, so a published sequence can
    // never point at an event that was not committed first.
    const run = await tx.codexPetRun.update({
      where: { id: args.runId },
      data: { lastEventSequence: { increment: 1 } },
      select: { id: true, projectId: true, userId: true, lastEventSequence: true },
    });
    return tx.codexPetEvent.create({
      data: {
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        sequence: run.lastEventSequence,
        type: args.type,
        stage: args.stage,
        jobKey: args.jobKey ?? null,
        message: args.message ? sanitizeCodexPetDiagnosticText(args.message, 1_000) : null,
        progress,
        payload: sanitizeCodexPetEventPayload(args.payload ?? {}),
      },
    });
  });

  try {
    const redis = args.redis ?? getRedis();
    await redis.publish(codexPetRunChannel(args.runId), String(event.sequence)).catch(() => undefined);
  } catch {
    // Persistence is authoritative; SSE falls back to database polling when
    // Redis is unavailable or not configured in a test/maintenance process.
  }
  return event;
}

export function serializeCodexPetEvent(event: {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly userId: string;
  readonly sequence: number;
  readonly type: string;
  readonly stage: string;
  readonly jobKey: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly payload: Prisma.JsonValue;
  readonly createdAt: Date;
}) {
  return {
    ...event,
    payload: event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {},
    createdAt: event.createdAt.toISOString(),
  };
}
