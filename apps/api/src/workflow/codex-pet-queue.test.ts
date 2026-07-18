import { beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; options: unknown; add: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  workers: [] as Array<{ name: string; processor: unknown; options: unknown }>,
  existingJob: null as null | { getState: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn(async () => undefined);
    getJob = vi.fn(async () => bull.existingJob);
    close = vi.fn(async () => undefined);
    constructor(readonly name: string, readonly options: unknown) {
      bull.queues.push(this);
    }
  },
  Worker: class {
    constructor(readonly name: string, readonly processor: unknown, readonly options: unknown) {
      bull.workers.push(this);
    }
  },
}));

import {
  CODEX_PET_QUEUE_NAME,
  closeCodexPetQueue,
  codexPetBullConnection,
  codexPetDefaultJobOptions,
  createCodexPetWorker,
  enqueueCodexPetRun,
} from "./codex-pet-queue.js";

describe("Codex pet BullMQ infrastructure", () => {
  beforeEach(async () => {
    await closeCodexPetQueue();
    bull.queues.length = 0;
    bull.workers.length = 0;
    bull.existingJob = null;
    process.env.REDIS_URL = "redis://localhost:6379/0";
  });

  it("keeps run identity and the single-attempt lifecycle caller-proof", async () => {
    await enqueueCodexPetRun(
      { runId: "run-review" },
      { jobId: "caller-must-not-change-this", removeOnComplete: false, removeOnFail: false, attempts: 7 },
    );

    expect(bull.queues).toHaveLength(1);
    expect(bull.queues[0]!.name).toBe(CODEX_PET_QUEUE_NAME);
    expect(bull.queues[0]!.add).toHaveBeenCalledWith("run", { runId: "run-review" }, expect.objectContaining({
      jobId: "run-review",
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    }));
  });

  it("does not add Bull retries even when a stale deployment still sets them", () => {
    const env = {
      REDIS_URL: "rediss://worker:secret@redis.example:6380/4",
      CODEX_PET_JOB_ATTEMPTS: "5",
      CODEX_PET_JOB_BACKOFF_MS: "9000",
      CODEX_PET_WORKER_CONCURRENCY: "6",
    } as NodeJS.ProcessEnv;
    expect(codexPetDefaultJobOptions(env)).toMatchObject({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(codexPetBullConnection(env)).toMatchObject({
      host: "redis.example",
      port: 6380,
      username: "worker",
      password: "secret",
      db: 4,
      tls: {},
      maxRetriesPerRequest: null,
    });
    const processor = vi.fn();
    createCodexPetWorker(processor, { env });
    expect(bull.workers[0]).toMatchObject({
      name: CODEX_PET_QUEUE_NAME,
      processor,
      options: { concurrency: 6 },
    });
  });

  it("removes a retained failed job before recovering the same runId", async () => {
    const remove = vi.fn(async () => undefined);
    const getState = vi.fn(async () => "failed");
    bull.existingJob = { getState, remove };

    await enqueueCodexPetRun({ runId: "run-stale" });

    expect(getState).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(bull.queues[0]!.add.mock.invocationCallOrder[0]!);
    expect(bull.queues[0]!.add).toHaveBeenCalledWith("run", { runId: "run-stale" }, expect.objectContaining({
      jobId: "run-stale",
      attempts: 1,
      removeOnFail: true,
    }));
  });

  it("rejects missing and non-Redis connection URLs", () => {
    expect(() => codexPetBullConnection({})).toThrow("REDIS_URL is required");
    expect(() => codexPetBullConnection({ REDIS_URL: "https://redis.example" })).toThrow("redis:// or rediss://");
  });
});
