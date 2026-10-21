import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  applyCheckpointChaptersDiff,
  buildCheckpointBranchSnapshot,
  buildCheckpointSnapshot,
  diffCheckpointChapters,
  resolveCheckpointChapters,
} from "./checkpoint-snapshot.js";
import { registerNovelResourceRoutes } from "./resource-routes.js";

vi.mock("./continuity-assets.js", () => ({ backfillNovelContinuityAssets: vi.fn() }));
vi.mock("./narrative-ledger.js", () => ({ backfillNovelNarrativeLedgers: vi.fn() }));
vi.mock("./score-backfill.js", () => ({ recalculateNovelChapterScores: vi.fn() }));

/**
 * 提示词 19 验收：检查点改增量后——
 * (1) 第二次存检查点写入的 JSON 字节数不随未变章节膨胀；
 * (2) 回滚到增量检查点后正文与存时逐字相等；
 * (3) 旧格式（全量 chapters、无 v）检查点照样能回滚。
 */

type Row = Record<string, unknown>;

function chapterRow(chapterIndex: number, content: string): Row {
  return {
    chapterIndex,
    volumeIndex: 1,
    title: `第 ${chapterIndex} 章`,
    summary: "",
    outline: "",
    generationHint: "",
    executionPlan: null,
    microBeats: [],
    content,
    rawContent: content,
    openThreads: [],
    contextSnapshot: null,
    generationMeta: null,
    consistencyJson: null,
    status: "ready",
    reviewStatus: "approved",
    reviewNotes: "",
    aiReview: "",
    aiActionItems: [],
    modificationRate: 0,
    billableChars: content.length,
    tensionScore: 0,
    plotTension: 0,
    emotionalTension: 0,
    pacingTension: 0,
    qualityScore: 0,
  };
}

const STRUCTURED_TABLES = [
  "novelWorldDimension", "novelStyleNote", "novelStructureNode", "novelCharacter",
  "novelCharacterRelation", "novelLocation", "novelTimelineEvent", "novelStoryline",
  "novelStorylineMilestone", "novelProp", "novelPropEvent", "novelNarrativeEvent",
  "novelCausalEdge", "novelNarrativeDebt", "novelEntityState", "novelKnowledgeFact",
  "novelForeshadowItem", "novelForeshadowEvent",
] as const;

function structuredFakes() {
  const tables: Record<string, unknown> = {
    novelBible: {
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "bible-1" })),
    },
  };
  for (const name of STRUCTURED_TABLES) {
    tables[name] = {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    };
  }
  return tables;
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return row;
  const out: Row = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

function makeWorld() {
  const chapters: Row[] = [];
  const checkpoints: Row[] = [];
  let seq = 0;
  const project: Row = {
    id: "project-1",
    userId: "user-1",
    title: "测试作品",
    genre: "玄幻",
    premise: "前提",
    settings: {},
    generationPrefs: {},
    narrativeContract: {},
    storyPhase: "opening",
    currentBranch: "main",
  };
  const store: Record<string, unknown> = {
    ...structuredFakes(),
    novelProject: {
      findFirst: vi.fn(async () => project),
      update: vi.fn(async ({ data }: { data: Row }) => {
        Object.assign(project, data);
        return project;
      }),
    },
    novelRun: { findFirst: vi.fn(async () => null) },
    novelChapter: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
        [...chapters].sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex)).map((row) => pick(row, select)),
      ),
      deleteMany: vi.fn(async () => {
        const count = chapters.length;
        chapters.length = 0;
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `row-${++seq}`, ...data };
        chapters.push(row);
        return row;
      }),
    },
    novelCheckpoint: {
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        const matches = checkpoints.filter((row) =>
          (where.id === undefined || row.id === where.id) &&
          (where.projectId === undefined || row.projectId === where.projectId) &&
          (where.branchName === undefined || row.branchName === where.branchName),
        );
        const found = matches[matches.length - 1];
        return found ? pick({ ...found }, select) : null;
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `cp-${++seq}`, createdAt: new Date(seq * 1000), ...data };
        checkpoints.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const row of checkpoints) {
          if (row.projectId === where.projectId && row.branchName === where.branchName && row.isHead === where.isHead) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = checkpoints.find((item) => item.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(store)),
  };
  return { store: store as unknown as PrismaClient, raw: store as Record<string, any>, chapters, checkpoints, project };
}

async function appFor(prisma: PrismaClient) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request) => {
    (request as typeof request & { userId: string }).userId = "user-1";
  });
  await registerNovelResourceRoutes(app, { prisma });
  return app;
}

describe("checkpoint chapters diff（纯函数）", () => {
  it("只收变化行与删除章号", () => {
    const before = [chapterRow(1, "甲"), chapterRow(2, "乙"), chapterRow(3, "丙")];
    const after = [chapterRow(1, "甲"), chapterRow(2, "乙改")];
    const diff = diffCheckpointChapters(before, after);
    expect(diff.upserts.map((row) => row.chapterIndex)).toEqual([2]);
    expect(diff.removedChapterIndexes).toEqual([3]);
    expect(applyCheckpointChaptersDiff(before, diff)).toEqual(after);
  });
});

describe("增量检查点（路由级）", () => {
  it("第二次写入不带未变章节正文；回滚增量/全量都逐字还原；旧格式兼容", async () => {
    const world = makeWorld();
    const long = (marker: string) => `${marker}正文`.repeat(60);
    world.chapters.push(
      chapterRow(1, long("第一章")),
      chapterRow(2, long("第二章")),
      chapterRow(3, long("第三章")),
    );
    const app = await appFor(world.store);

    // 第一次：无父检查点 → 全量
    const first = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints", payload: { label: "cp1" } });
    expect(first.statusCode).toBe(201);
    const cp1 = world.checkpoints.at(-1)!;
    expect(Array.isArray((cp1.snapshot as Row).chapters)).toBe(true);
    const firstBytes = JSON.stringify(cp1.snapshot).length;

    // 只改第二章正文 → 第二次写入只能带第二章
    const edited = long("第二章·改");
    world.chapters[1]!.content = edited;
    world.chapters[1]!.rawContent = edited;
    const second = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints", payload: { label: "cp2" } });
    expect(second.statusCode).toBe(201);
    const cp2 = world.checkpoints.at(-1)!;
    const snapshot2 = cp2.snapshot as Row;
    expect(snapshot2.chapters).toBeUndefined();
    const diff = snapshot2.chaptersDiff as { upserts: Row[]; removedChapterIndexes: number[] };
    expect(diff.upserts.map((row) => row.chapterIndex)).toEqual([2]);
    expect(diff.removedChapterIndexes).toEqual([]);
    const secondBytes = JSON.stringify(cp2.snapshot).length;
    expect(secondBytes).toBeLessThan(firstBytes * 0.6);
    expect(JSON.stringify(cp2.snapshot)).not.toContain("第一章正文");

    // 再把正文弄乱，回滚到 cp2 → 与存 cp2 时逐字相等
    world.chapters[0]!.content = "被污染的第一章";
    world.chapters[1]!.content = "被污染的第二章";
    const rollback2 = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/project-1/checkpoints/${cp2.id}/rollback` });
    expect(rollback2.statusCode).toBe(200);
    const byIndex = [...world.chapters].sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex));
    expect(byIndex.map((row) => row.content)).toEqual([long("第一章"), edited, long("第三章")]);
    expect(byIndex.map((row) => row.rawContent)).toEqual([long("第一章"), edited, long("第三章")]);

    // 回滚到 cp1（全量）→ 原始三章逐字相等
    const rollback1 = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/project-1/checkpoints/${cp1.id}/rollback` });
    expect(rollback1.statusCode).toBe(200);
    const restored = [...world.chapters].sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex));
    expect(restored.map((row) => row.content)).toEqual([long("第一章"), long("第二章"), long("第三章")]);

    // 旧格式检查点（无 v、直接带 chapters）直接种进库，回滚照样工作
    world.checkpoints.push({
      id: "cp-legacy",
      projectId: "project-1",
      branchName: "main",
      parentId: null,
      chapterNumber: 1,
      label: "旧格式",
      isHead: false,
      createdAt: new Date(999_000),
      snapshot: {
        project: { title: "旧作品", genre: "", premise: "", settings: {}, generationPrefs: {}, narrativeContract: {}, storyPhase: "opening" },
        chapters: [chapterRow(1, "旧格式正文")],
      },
    });
    const rollbackLegacy = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints/cp-legacy/rollback" });
    expect(rollbackLegacy.statusCode).toBe(200);
    expect(world.chapters.map((row) => row.content)).toEqual(["旧格式正文"]);
    await app.close();
  });

  it("分支检查点存空差量，回滚分支能沿父链重建源状态", async () => {
    const world = makeWorld();
    world.chapters.push(chapterRow(1, "主线第一章"), chapterRow(2, "主线第二章"));
    const app = await appFor(world.store);
    await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints", payload: { label: "主线" } });
    const source = world.checkpoints.at(-1)!;

    // 改掉主线正文后建分支：分支恢复的应是源检查点状态，不是当前正文
    world.chapters[0]!.content = "主线已推进的新正文";
    const branch = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/project-1/checkpoints/${source.id}/branch`,
      payload: { branchName: "world-b" },
    });
    expect(branch.statusCode).toBe(201);
    const branchRow = world.checkpoints.at(-1)!;
    expect(JSON.stringify(branchRow.snapshot)).not.toContain("主线第一章");
    expect(world.chapters.map((row) => row.content)).toEqual(["主线第一章", "主线第二章"]);

    // 之后回滚到分支检查点（空差量 → 父链重建）
    world.chapters[0]!.content = "又改了";
    const rollback = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/project-1/checkpoints/${branchRow.id}/rollback` });
    expect(rollback.statusCode).toBe(200);
    expect(world.chapters.map((row) => row.content)).toEqual(["主线第一章", "主线第二章"]);
    await app.close();
  });
});

describe("resolveCheckpointChapters 父链异常", () => {
  it("父检查点缺失时抛错而不是给错状态", async () => {
    const snapshot = buildCheckpointSnapshot({
      project: {},
      chapters: [chapterRow(1, "甲")],
      structured: null,
      parentChapters: [],
    });
    const store = {
      novelCheckpoint: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    await expect(resolveCheckpointChapters(store, { id: "cp-x", parentId: "cp-missing", snapshot })).rejects.toThrow(/父链断裂/);
  });

  it("分支空差量盖在旧格式基底上能重建", async () => {
    const legacy = {
      project: {},
      chapters: [chapterRow(1, "旧一"), chapterRow(2, "旧二")],
    };
    const branchSnapshot = buildCheckpointBranchSnapshot(legacy);
    const store = {
      novelCheckpoint: {
        findFirst: vi.fn(async () => ({ id: "cp-base", parentId: null, snapshot: legacy })),
      },
    } as unknown as PrismaClient;
    const rebuilt = await resolveCheckpointChapters(store, { id: "cp-branch", parentId: "cp-base", snapshot: branchSnapshot });
    expect(rebuilt.map((row) => row.content)).toEqual(["旧一", "旧二"]);
  });
});
