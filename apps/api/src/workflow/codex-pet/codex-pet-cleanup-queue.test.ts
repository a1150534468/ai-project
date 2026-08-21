import { beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; add: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  existingJob: null as null | { getState: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn(async () => undefined);
    getJob = vi.fn(async () => bull.existingJob);
    close = vi.fn(async () => undefined);
    constructor(readonly name: string) {
      bull.queues.push(this);
    }
  },
  Worker: class {},
}));

import {
  closeCodexPetCleanupQueue,
  enqueueCodexPetProjectCleanup,
} from "./codex-pet-cleanup.js";

describe("Codex pet cleanup BullMQ enqueueing", () => {
  beforeEach(async () => {
    await closeCodexPetCleanupQueue();
    bull.queues.length = 0;
    bull.existingJob = null;
    process.env.REDIS_URL = "redis://localhost:6379/0";
  });

  it("removes an exhausted failed job before re-enqueueing the project", async () => {
    const remove = vi.fn(async () => undefined);
    const getState = vi.fn(async () => "failed");
    bull.existingJob = { getState, remove };

    await enqueueCodexPetProjectCleanup({ userId: "user-1", projectId: "project-1" });

    const queue = bull.queues[0]!;
    expect(getState).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    expect(queue.add).toHaveBeenCalledWith("cleanup", { userId: "user-1", projectId: "project-1" }, expect.objectContaining({
      jobId: "project-project-1",
    }));
  });

  it("keeps a live or pending job and relies on BullMQ idempotency", async () => {
    const remove = vi.fn(async () => undefined);
    const getState = vi.fn(async () => "active");
    bull.existingJob = { getState, remove };

    await enqueueCodexPetProjectCleanup({ userId: "user-1", projectId: "project-1" });

    expect(remove).not.toHaveBeenCalled();
    expect(bull.queues[0]!.add).toHaveBeenCalledOnce();
  });
});

