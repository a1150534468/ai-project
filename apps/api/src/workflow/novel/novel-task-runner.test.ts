import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { runNovelTask, type NovelTaskRow } from "./novel-task-runner.js";

describe("novel task runner idempotency", () => {
  it("does not regenerate a task that a previous delivery already completed", async () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      userId: "user-1",
      targetKind: "chapter",
      targetId: null,
      operationId: "operation-1",
      status: "queued",
      progressPercent: 0,
      progressStage: "queued",
      progressMessage: null,
      progressPreview: "",
      streamedChars: 0,
      requestPayload: {},
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      cancelledAt: null,
    } satisfies NovelTaskRow;
    const prisma = { novelTask: { findUnique: vi.fn(async () => ({ ...task, status: "succeeded" })) } } as unknown as PrismaClient;
    const generator = vi.fn();
    await expect(runNovelTask({ prisma, generator, task })).resolves.toBeUndefined();
    expect(generator).not.toHaveBeenCalled();
  });
});
