/**
 * P1.4 —— 钉住「AI 产物自动归档进知识库」这套 Postgres 触发器已经删干净。
 *
 * 断言是 P0.1 的整体反转。P0.1 锁的是带 bug 的现状（建用户白送一个系统库、
 * sizeBytes 恒为 0、删源不删文档、改个标题就把已索引文档打回 pending、
 * 归档抛错连带业务写入回滚）；P1.1 的迁移
 * `20260831120000_drop_ai_artifact_archive_triggers` 删掉 11 个触发器 + 13 个
 * 函数之后，同样这几件事都不再发生。
 *
 * 存在的理由和 P0.1 一样：触发器是数据库侧的隐式行为，Prisma schema 里看不见。
 * 只删迁移不留断言，下一个人再写个迁移把它加回来，CI 依然全绿。
 *
 * 计划：`docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md`
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

/** 被删掉的触发器用的确定性 KB 主键：`ai_artifacts_` || md5(userId)。 */
function artifactKbId(userId: string): string {
  return `ai_artifacts_${md5(userId)}`;
}

/** 被删掉的触发器用的确定性文档主键：`ai_artifact_` || md5(module:sourceId)。 */
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

describe.skipIf(!databaseEnabled)("AI 产物归档触发器已删除", () => {
  it("11 个触发器和 13 个函数在库上都不存在了", async () => {
    const [triggers, functions] = await Promise.all([
      prisma.$queryRaw<Array<{ readonly tgname: string }>>`
        SELECT t."tgname"::text AS "tgname"
        FROM pg_trigger t
        JOIN pg_proc p ON p."oid" = t."tgfoid"
        WHERE NOT t."tgisinternal"
          AND (p."proname" LIKE 'archive\\_%\\_trigger' OR p."proname" = 'create_ai_artifacts_kb_for_user_trigger')
        ORDER BY t."tgname"
      `,
      prisma.$queryRaw<Array<{ readonly proname: string }>>`
        SELECT p."proname"::text AS "proname"
        FROM pg_proc p
        JOIN pg_namespace n ON n."oid" = p."pronamespace"
        WHERE n."nspname" = current_schema()
          AND (p."proname" LIKE 'archive\\_%' OR p."proname" LIKE '%\\_ai\\_artifacts\\_kb%')
        ORDER BY p."proname"
      `,
    ]);
    expect(triggers).toEqual([]);
    expect(functions).toEqual([]);
  });

  it("建用户不再白送一个 AI_ARTIFACTS 系统库", async () => {
    const user = await createUser("provision");
    expect(await prisma.knowledgeBase.findUnique({ where: { id: artifactKbId(user.id) } })).toBeNull();
    // 一个新用户名下现在是零个知识库——官方库靠 ownerType=OFFICIAL 共享，
    // 个人库要用户自己建。这一条比按 systemKey 查更强：P5.1 已经把
    // `systemKey` 列连同 userId_systemKey 唯一索引一起删了，「系统知识库」
    // 这个概念不存在了，所以「一个都没有」就是完整断言。
    expect(await prisma.knowledgeBase.count({ where: { userId: user.id } })).toBe(0);
  });

  it("插一张图不再生成 ARTIFACT 文档", async () => {
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
    expect(await prisma.document.findUnique({ where: { id: artifactDocId("image", asset.id) } })).toBeNull();
    expect(await prisma.document.count({ where: { sourceModule: "image", sourceId: asset.id } })).toBe(0);
    // 图片本身照常落库：删掉的只是事后登记那一步。
    expect(await prisma.imageAsset.findUniqueOrThrow({ where: { id: asset.id } }))
      .toMatchObject({ prompt: "一只戴墨镜的柯基", userId: user.id });
  });

  it("删掉源图不再留下孤儿死链文档（本来就没有文档可留）", async () => {
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
    await prisma.imageAsset.delete({ where: { id: asset.id } });
    expect(await prisma.document.findUnique({ where: { id: artifactDocId("image", asset.id) } })).toBeNull();
    expect(await prisma.document.count({ where: { sourceModule: "image", sourceId: asset.id } })).toBe(0);
  });

  it("改小说章节标题不再动任何文档索引状态", async () => {
    const user = await createUser("reindex");
    const project = await prisma.novelProject.create({ data: { userId: user.id, title: "钉子小说" } });
    const chapter = await prisma.novelChapter.create({
      data: { projectId: project.id, chapterIndex: 1, title: "第一稿", content: "正文内容不变。" },
    });
    // 触发器在的时候，这一次 UPDATE OF "title" 会把已索引文档打回 pending 并把
    // attempts 归零；现在连文档都不存在，改标题就只是改标题。
    await prisma.novelChapter.update({ where: { id: chapter.id }, data: { title: "第二稿" } });
    expect(await prisma.document.findUnique({ where: { id: artifactDocId("novel", chapter.id) } })).toBeNull();
    expect(await prisma.document.count({ where: { sourceModule: "novel", sourceId: chapter.id } })).toBe(0);
    expect(await prisma.novelChapter.findUniqueOrThrow({ where: { id: chapter.id } }))
      .toMatchObject({ title: "第二稿", content: "正文内容不变。" });
  });

  it("确定性主键上先放一个诱饵文档，也不再连带回滚业务写入", async () => {
    const user = await createUser("rollback");
    const assetId = `trigger-pin-collide-${Date.now()}`;
    const kb = await prisma.knowledgeBase.create({
      data: { ownerType: "USER", userId: user.id, name: "手建库" },
    });
    // P0.1 里这个诱饵会让触发器的 INSERT 撞 Document_pkey，unique_violation
    // 原样抛出，用户的生图记录被一次「事后登记」干掉——产物落 KB 最贵的那笔账。
    await prisma.document.create({
      data: {
        id: artifactDocId("image", assetId),
        kbId: kb.id,
        name: "占位诱饵",
        sourceType: "TEXT",
        sourceModule: "image",
        sourceId: `decoy-${assetId}`,
      },
    });

    await prisma.imageAsset.create({
      data: {
        id: assetId,
        userId: user.id,
        requestId: `req-collide-${Date.now()}`,
        requestIndex: 0,
        prompt: "这张图现在写得进去",
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: "https://example.invalid/collide.png",
        thumbnailUrl: "https://example.invalid/collide-thumb.png",
      },
    });

    expect(await prisma.imageAsset.findUniqueOrThrow({ where: { id: assetId } }))
      .toMatchObject({ prompt: "这张图现在写得进去" });
  });

  it("并发产物不再抢同一个 KnowledgeBase 行的写锁", async () => {
    const user = await createUser("hotspot");
    await Promise.all(Array.from({ length: 4 }, (_unused, index) => prisma.imageAsset.create({
      data: {
        userId: user.id,
        requestId: `req-hotspot-${Date.now()}`,
        requestIndex: index,
        prompt: `热点行 ${index}`,
        model: "test-image-model",
        size: "1024x1024",
        originalUrl: `https://example.invalid/h${index}.png`,
        thumbnailUrl: `https://example.invalid/h${index}-thumb.png`,
      },
    })));
    // 触发器在的时候，同一用户的每张图都要 ON CONFLICT DO UPDATE 同一行 KB，
    // 全部串行化在那一行上；现在既没有那行 KB，也没有文档。
    expect(await prisma.knowledgeBase.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.imageAsset.count({ where: { userId: user.id } })).toBe(4);
  });
});
