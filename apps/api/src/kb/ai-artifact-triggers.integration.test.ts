/**
 * P0.1 — 把「AI 产物自动归档进知识库」这套 Postgres 触发器的**现状**钉住。
 *
 * 这些断言故意锁定包含 bug 的当前行为（sizeBytes 恒为 0、删源不删文档、
 * 重复归档把 attempts 归零、归档失败连带业务写入回滚）。计划见
 * `docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md`：
 * P1 删掉触发器后，本文件的断言要按 P1.4 整体反转。
 *
 * 存在的理由：删除前这套触发器的回归覆盖是零，删对了删错了 CI 都是绿的。
 */
import { createHash } from "node:crypto";
import { getPrisma } from "@ai-assistant/db";
import { afterAll, describe, expect, it } from "vitest";

const prisma = getPrisma();
const databaseEnabled = Boolean(process.env.DATABASE_URL);

const createdUserIds: string[] = [];

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/** 触发器里 KB 主键是确定性的：`ai_artifacts_` || md5(userId)。 */
function artifactKbId(userId: string): string {
  return `ai_artifacts_${md5(userId)}`;
}

/** 触发器里文档主键是确定性的：`ai_artifact_` || md5(module:sourceId)。 */
function artifactDocId(sourceModule: string, sourceId: string): string {
  return `ai_artifact_${md5(`${sourceModule}:${sourceId}`)}`;
}

async function createUser(tag: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: { uid: `trigger-${tag}-${suffix}`, username: `trigger-${tag}-${suffix}`, passwordHash: "dummy" },
  });
  createdUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (!databaseEnabled || createdUserIds.length === 0) return;
  // KnowledgeBase.userId 没有指向 User 的外键，删用户不会级联掉库；必须显式清。
  await prisma.knowledgeBase.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe.skipIf(!databaseEnabled)("AI 产物归档触发器（现状钉子）", () => {
  it("11 个触发器都确实装在库上", async () => {
    const rows = await prisma.$queryRaw<Array<{ readonly tgname: string }>>`
      SELECT t."tgname"::text AS "tgname"
      FROM pg_trigger t
      JOIN pg_proc p ON p."oid" = t."tgfoid"
      WHERE NOT t."tgisinternal"
        AND (p."proname" LIKE 'archive\\_%\\_trigger' OR p."proname" = 'create_ai_artifacts_kb_for_user_trigger')
      ORDER BY t."tgname"
    `;
    expect(rows.map((row) => row.tgname)).toEqual([
      "AgentWorkflowRun_archive",
      "ArticleWorkflowProject_archive",
      "AudioAsset_archive",
      "ComicWorkflowScriptVersion_archive",
      "DubProject_archive",
      "ImageAsset_archive",
      "LocalBusinessPromoProject_archive",
      "NovelChapter_archive",
      "ScheduledTaskRun_archive",
      "User_ai_artifacts_kb",
      "VideoAsset_archive",
    ]);
  });

  it("建用户就自动开一个 AI_ARTIFACTS 系统库（用户没要求过）", async () => {
    const user = await createUser("provision");
    const kb = await prisma.knowledgeBase.findUnique({
      where: { userId_systemKey: { userId: user.id, systemKey: "AI_ARTIFACTS" } },
    });
    expect(kb).not.toBeNull();
    expect(kb!.id).toBe(artifactKbId(user.id));
    expect(kb!.ownerType).toBe("USER");
    expect(kb!.name).toBe("AI 产物");
  });

  it("插一张图就自动生成 ARTIFACT 文档，且 sizeBytes 恒为 0", async () => {
    const user = await createUser("image");
    const asset = await prisma.imageAsset.create({
      data: {
        userId: user.id,
        requestId: `req-pin-${Date.now()}`,
        requestIndex: 0,
        prompt: "一只戴墨镜的柯基",
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: "https://example.invalid/a.png",
        thumbnailUrl: "https://example.invalid/a-thumb.png",
        mime: "image/png",
      },
    });
    const doc = await prisma.document.findUnique({ where: { id: artifactDocId("image", asset.id) } });
    expect(doc).not.toBeNull();
    expect(doc!.kbId).toBe(artifactKbId(user.id));
    expect(doc!.sourceType).toBe("ARTIFACT");
    expect(doc!.sourceModule).toBe("image");
    expect(doc!.sourceId).toBe(asset.id);
    expect(doc!.content).toBe("图片提示词：一只戴墨镜的柯基");
    expect(doc!.status).toBe("pending");
    expect(doc!.attempts).toBe(0);
    // 触发器硬编码 sizeBytes = 0：产物不占 usedBytes 配额，也让配额统计与真实体积脱节。
    expect(doc!.sizeBytes).toBe(0);
    expect(doc!.metadata).toMatchObject({ model: "test-image-model", size: "1024x1024" });
  });

  it("删掉源图，归档文档还留着（孤儿死链，没有 DELETE 触发器）", async () => {
    const user = await createUser("orphan");
    const asset = await prisma.imageAsset.create({
      data: {
        userId: user.id,
        requestId: `req-orphan-${Date.now()}`,
        requestIndex: 0,
        prompt: "会被删掉的图",
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: "https://example.invalid/gone.png",
        thumbnailUrl: "https://example.invalid/gone-thumb.png",
      },
    });
    const docId = artifactDocId("image", asset.id);
    await prisma.imageAsset.delete({ where: { id: asset.id } });
    const doc = await prisma.document.findUnique({ where: { id: docId } });
    expect(doc).not.toBeNull();
    expect(doc!.sourceUri).toBe("https://example.invalid/gone.png");
  });

  it("改一次标题就把已索引的文档打回 pending，attempts 归零、error 清空", async () => {
    const user = await createUser("reindex");
    const project = await prisma.novelProject.create({ data: { userId: user.id, title: "钉子小说" } });
    const chapter = await prisma.novelChapter.create({
      data: { projectId: project.id, chapterIndex: 1, title: "第一稿", content: "正文内容不变。" },
    });
    const docId = artifactDocId("novel", chapter.id);

    // 模拟索引器已经跑完、且已耗尽重试的终态。
    await prisma.document.update({
      where: { id: docId },
      data: { status: "failed", attempts: 3, error: "embeddings 400", chunkCount: 7, tokensUsed: 123 },
    });

    // 正文一个字没动，只改标题——UPDATE OF "title" 命中触发器。
    await prisma.novelChapter.update({ where: { id: chapter.id }, data: { title: "第二稿" } });

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.status).toBe("pending");
    expect(doc.attempts).toBe(0);
    expect(doc.error).toBeNull();
    // chunkCount/tokensUsed 不在 upsert 的 SET 列表里：旧 Chunk 的计数留在原地，
    // 索引器重跑又会插一批新的，没有 (documentId, ordinal) 唯一约束兜着。
    expect(doc.chunkCount).toBe(7);
    expect(doc.tokensUsed).toBe(123);
  });

  it("归档抛错会把业务写入一起回滚（触发器里没有 EXCEPTION 兜底）", async () => {
    const user = await createUser("rollback");
    const assetId = `trigger-pin-collide-${Date.now()}`;
    // 抢占触发器将要用的确定性主键，但挂在另一组 (sourceModule, sourceId) 上：
    // 触发器的 INSERT 会撞 Document_pkey，而 ON CONFLICT 只处理
    // (sourceModule, sourceId)，于是 unique_violation 原样抛出。
    await prisma.document.create({
      data: {
        id: artifactDocId("image", assetId),
        kbId: artifactKbId(user.id),
        name: "占位诱饵",
        sourceType: "ARTIFACT",
        sourceModule: "image",
        sourceId: `decoy-${assetId}`,
      },
    });

    await expect(prisma.imageAsset.create({
      data: {
        id: assetId,
        userId: user.id,
        requestId: `req-collide-${Date.now()}`,
        requestIndex: 0,
        prompt: "这张图会因为归档失败而写不进去",
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: "https://example.invalid/collide.png",
        thumbnailUrl: "https://example.invalid/collide-thumb.png",
      },
    })).rejects.toThrow();

    // 用户的生图记录被一个"事后登记"动作干掉了——这就是产物落 KB 最贵的那笔账。
    expect(await prisma.imageAsset.findUnique({ where: { id: assetId } })).toBeNull();
  });

  it("每次归档都动一次 KnowledgeBase 行，但 updatedAt 自赋值不变（纯锁竞争）", async () => {
    const user = await createUser("hotspot");
    const kbBefore = await prisma.knowledgeBase.findUniqueOrThrow({
      where: { userId_systemKey: { userId: user.id, systemKey: "AI_ARTIFACTS" } },
    });
    await prisma.imageAsset.create({
      data: {
        userId: user.id,
        requestId: `req-hotspot-${Date.now()}`,
        requestIndex: 0,
        prompt: "热点行",
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: "https://example.invalid/h.png",
        thumbnailUrl: "https://example.invalid/h-thumb.png",
      },
    });
    const kbAfter = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbBefore.id } });
    // ON CONFLICT DO UPDATE SET "updatedAt" = "KnowledgeBase"."updatedAt"：
    // 值没变，但这是一次真实的行更新，会拿写锁。同一用户的并发产物全部串行化在这一行上。
    expect(kbAfter.updatedAt.getTime()).toBe(kbBefore.updatedAt.getTime());
    // 文档的 updatedAt 反过来每次都刷新——agent-teams 按 updatedAt desc 取前 2 篇，
    // 于是产物永远压在用户自己上传的资料前面。
    const doc = await prisma.document.findFirstOrThrow({ where: { kbId: kbBefore.id } });
    expect(doc.updatedAt.getTime()).toBeGreaterThanOrEqual(kbBefore.createdAt.getTime());
  });
});
