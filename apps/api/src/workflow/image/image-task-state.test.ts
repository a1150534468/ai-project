import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { updateTask } from "./image-route-helpers.js";

describe("image task conditional state writes", () => {
  it("writes only while the task is still running", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      imageGenerationTask: { updateMany, findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await updateTask(prisma, "task-1", { status: "completed", completedCount: 2 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "running" },
      data: { status: "completed", completedCount: 2 },
    });
  });

  it("does not overwrite cancellation when an old worker publishes later", async () => {
    const prisma = {
      imageGenerationTask: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => ({ id: "task-1", status: "cancelled" })),
      },
    } as unknown as PrismaClient;

    await expect(updateTask(prisma, "task-1", { status: "completed" }))
      .rejects.toMatchObject({ status: "cancelled" });
  });
});
