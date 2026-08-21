import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  appendCodexPetEvent,
  codexPetRunChannel,
  sanitizeCodexPetEventPayload,
  sanitizeCodexPetDiagnosticText,
  serializeCodexPetEvent,
} from "./codex-pet-events.js";

function fakeEventStore() {
  let sequence = 0;
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const tx = {
    codexPetRun: {
      update: vi.fn(async () => {
        order.push("increment");
        sequence += 1;
        return { id: "run-1", projectId: "project-1", userId: "user-1", lastEventSequence: sequence };
      }),
    },
    codexPetEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push("insert");
        const event = { id: `event-${data.sequence}`, createdAt: new Date("2026-07-17T00:00:00.000Z"), ...data };
        events.push(event);
        return event;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      order.push("transaction.begin");
      const result = await callback(tx);
      order.push("transaction.commit");
      return result;
    }),
  } as unknown as PrismaClient;
  return { prisma, events, order };
}

describe("Codex pet persisted events", () => {
  it("commits monotonically before notifying Redis", async () => {
    const store = fakeEventStore();
    const publish = vi.fn(async () => {
      store.order.push("publish");
      return 1;
    });
    await appendCodexPetEvent({
      prisma: store.prisma,
      redis: { publish } as never,
      runId: "run-1",
      type: "job.started",
      stage: "base_generating",
      jobKey: "base:0",
      message: "开始生成主形象",
      progress: 7.6,
    });
    await appendCodexPetEvent({
      prisma: store.prisma,
      redis: { publish } as never,
      runId: "run-1",
      type: "job.completed",
      stage: "base_generating",
      progress: 120,
    });
    await appendCodexPetEvent({
      prisma: store.prisma,
      redis: { publish } as never,
      runId: "run-1",
      type: "validation.warning",
      stage: "validating",
      progress: Number.NaN,
    });

    expect(store.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(store.events.map((event) => event.progress)).toEqual([8, 100, 0]);
    expect(store.order.slice(0, 5)).toEqual(["transaction.begin", "increment", "insert", "transaction.commit", "publish"]);
    expect(publish).toHaveBeenLastCalledWith(codexPetRunChannel("run-1"), "3");
  });

  it("keeps a committed event when Redis notification is unavailable", async () => {
    const store = fakeEventStore();
    await expect(appendCodexPetEvent({
      prisma: store.prisma,
      redis: { publish: vi.fn(async () => { throw new Error("redis down"); }) } as never,
      runId: "run-1",
      type: "run.queued",
      stage: "queued",
    })).resolves.toMatchObject({ sequence: 1 });
    expect(store.events).toHaveLength(1);
  });

  it("redacts binary data, private object keys, credentials, and prompts", () => {
    const sanitized = sanitizeCodexPetEventPayload({
      ok: true,
      upstreamRequestId: "req-safe-123",
      nested: { objectKey: "workflow/codex-pets/secret", api_key: "key", count: 2 },
      prompt: "internal generation prompt",
      image: `data:image/png;base64,${"A".repeat(600)}`,
      diagnostic: `relay rejected {"prompt":"private prompt","api_key":"sk-super-secret-key","objectKey":"workflow/codex-pets/u/p/r/private.png"} data:image/png;base64,${"A".repeat(600)}`,
    });
    expect(sanitized).toEqual({
      ok: true,
      upstreamRequestId: "req-safe-123",
      nested: { count: 2 },
      image: "[redacted binary]",
      diagnostic: "relay rejected {\"prompt\":\"[redacted]\",\"api_key\":\"[redacted]\",\"objectKey\":\"[redacted]\"} [redacted binary]",
    });
  });

  it("sanitizes persisted event messages that echo upstream request data", async () => {
    const store = fakeEventStore();
    await appendCodexPetEvent({
      prisma: store.prisma,
      redis: { publish: vi.fn(async () => 1) } as never,
      runId: "run-1",
      type: "run.failed",
      stage: "failed",
      message: `Bearer raw-token workflow/codex-pets/u/p/r/private.png https://example.test/a?exp=1&sig=secret data:image/png;base64,${"A".repeat(600)}`,
    });
    expect(store.events[0]?.message).toBe("Bearer [redacted] [redacted object key] [redacted signed url] [redacted binary]");
  });

  it("redacts standalone credential-shaped diagnostics", () => {
    expect(sanitizeCodexPetDiagnosticText("provider rejected sk-1234567890abcdef"))
      .toBe("provider rejected [redacted api key]");
  });

  it("serializes dates and normalizes a non-object payload", () => {
    expect(serializeCodexPetEvent({
      id: "event-1",
      projectId: "project-1",
      runId: "run-1",
      userId: "user-1",
      sequence: 1,
      type: "run.queued",
      stage: "queued",
      jobKey: null,
      message: null,
      progress: 0,
      payload: [] as never,
      createdAt: new Date("2026-07-17T12:30:00.000Z"),
    })).toMatchObject({ payload: {}, createdAt: "2026-07-17T12:30:00.000Z" });
  });
});
