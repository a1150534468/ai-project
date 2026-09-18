/**
 * 六个源的 SQL **真的能跑**，且准入/隔离/分页在 Postgres 上成立。
 *
 * 这是 P3.1 唯一验证得了下面这几件事的地方：
 *   - `imageAdmissionWhere` 那坨嵌套 OR/AND/NOT 是合法的 Prisma 输入（单测只验语义，不验它能不能被翻成 SQL）；
 *   - 桌宠那条手写 `$queryRawUnsafe` 的 JOIN 与 `$n` 占位符对得上（游标分支的编号是手算的）；
 *   - 「跨源同毫秒」下键集分页在真实 SQL 上不重不漏（「一行多素材」的源随 Phase 1 下线，
 *     那条性质改由 asset-cursor / asset-service 的单测钉住）。
 *
 * 取件链接一律注入假的：素材库自己不签链接（asset-sources.ts 第 1 条约束），
 * 所以这个测试不需要任何签名密钥，只需要一个库。
 */
import { getPrisma } from "@ai-assistant/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeAssetCursor } from "./asset-cursor.js";
import { listAssets } from "./asset-service.js";
import type { AssetSourceDeps } from "./asset-sources.js";
import type { AssetCursor, AssetItem } from "./asset-types.js";

const prisma = getPrisma();
const databaseEnabled = Boolean(process.env.DATABASE_URL);

const deps: AssetSourceDeps = {
  prisma,
  portraitBlobUrl: (id, key) => `portrait://${id}/${key}`,
  tryOnBlobUrl: (id, key) => `try-on://${id}/${key}`,
  imageBlobUrl: (imageId, objectKey) => `img://${imageId}/${objectKey}`,
  codexPetArtifactUrl: (artifact) => `pet://${artifact.id}`,
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userIds: string[] = [];

/** 同一毫秒上故意堆两个不同源的行：跨源分支只比前缀，这里是它唯一被真 SQL 验到的地方。 */
const TIE = new Date("2026-08-31T10:00:00.000Z");
const at = (minutesAgo: number) => new Date(TIE.getTime() - minutesAgo * 60_000);

async function createUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: { uid: `asset-${tag}-${suffix}`, username: `asset-${tag}-${suffix}`, passwordHash: "x" },
  });
  userIds.push(user.id);
  return user.id;
}

async function createImage(
  userId: string,
  requestId: string,
  createdAt: Date,
  objectKey: string | null = `obj/${requestId}`,
) {
  return prisma.imageAsset.create({
    data: {
      userId,
      requestId,
      requestIndex: 0,
      prompt: `prompt ${requestId}`,
      model: "gpt-image-2",
      size: "1024x1024",
      originalUrl: `https://upstream.test/${encodeURIComponent(requestId)}.png`,
      thumbnailUrl: `https://upstream.test/${encodeURIComponent(requestId)}-thumb.png`,
      objectKey,
      createdAt,
    },
  });
}

let ids: Record<string, string> = {};
let mainUserId = "";
let otherUserId = "";

async function seedHumanImages(userId: string) {
  const shared = { userId, model: "gpt-image-2", aspectRatio: "3:4", resolution: "1K", count: 1,
    effectivePrompt: "local regression fixture", status: "succeeded", completedCount: 1,
    billingResourceKey: "image", billingStatus: "settled", consentVersion: "test" };
  const portrait = await prisma.portraitTask.create({ data: {
    ...shared, requestId: `portrait-${userId}-${suffix}`, presetId: "business",
    billingOperationId: `portrait-${userId}-${suffix}`,
    outputs: { create: { userId, requestIndex: 0, objectKey: `qa/${suffix}/${userId}/portrait.png`, width: 768, height: 1024, sizeBytes: 10, createdAt: TIE } },
  }, include: { outputs: true } });
  const tryOn = await prisma.tryOnTask.create({ data: {
    ...shared, requestId: `try-on-${userId}-${suffix}`, garmentFrontAssetId: "fixture-reference",
    billingOperationId: `try-on-${userId}-${suffix}`,
    outputs: { create: { userId, requestIndex: 0, objectKey: `qa/${suffix}/${userId}/try-on.png`, width: 768, height: 1024, sizeBytes: 10, createdAt: TIE } },
  }, include: { outputs: true } });
  return { portrait: portrait.outputs[0]!, tryOn: tryOn.outputs[0]! };
}

async function seedMainUser() {
  const admitted = await Promise.all([
    createImage(mainUserId, `req-${suffix}`, at(1)),
    createImage(mainUserId, `article:wf-${suffix}:0`, at(2)),
    createImage(mainUserId, `ecom-master:wf-${suffix}:0`, at(3)),
    createImage(mainUserId, `ecom-reference:${suffix}`, at(4)),
    // 没有 objectKey 的历史行：url 必须回落到上游地址，而不是签一条指向空 key 的链接。
    createImage(mainUserId, `img-nokey-${suffix}`, at(5), null),
    createImage(mainUserId, `tie-image-${suffix}`, TIE),
  ]);
  const denied = await Promise.all([
    createImage(mainUserId, `comic:ep-${suffix}:0`, at(6)),
    createImage(mainUserId, `ecom-stitch:wf-${suffix}:0`, at(7)),
    createImage(mainUserId, `ecom-unknown:${suffix}`, at(8)),
  ]);

  const video = await prisma.videoAsset.create({
    data: {
      userId: mainUserId,
      requestId: `vid-${suffix}`,
      prompt: "一段视频",
      model: "veo-3",
      aspectRatio: "16:9",
      resolution: "1080p",
      durationSec: 8,
      originalUrl: "https://upstream.test/v.mp4",
      createdAt: at(9),
    },
  });

  const audioKinds = ["narration", "bgm", "voice-sample", "tts-fragment"];
  const audios = await Promise.all(
    audioKinds.map((kind, index) =>
      prisma.audioAsset.create({
        data: {
          userId: mainUserId,
          kind,
          source: "test",
          originalUrl: `https://upstream.test/${kind}.wav`,
          durationSec: 3,
          createdAt: at(10 + index),
        },
      }),
    ),
  );

  return { admitted, denied, video, audios };
}

/** 桌宠：一个 run 指着 base + package 两个 artifact，另外两个（含 691 行的 animation_preview）无人指。 */
async function seedCodexPet(userId: string, deleted: boolean, tag: string) {
  const project = await prisma.codexPetProject.create({
    data: { userId, name: `桌宠-${tag}`, deletedAt: deleted ? new Date() : null, createdAt: at(30) },
  });
  const run = await prisma.codexPetRun.create({
    data: { projectId: project.id, userId, createdAt: at(30) },
  });
  const makeArtifact = (slot: string, kind: string, mime: string, createdAt: Date) =>
    prisma.codexPetArtifact.create({
      data: {
        projectId: project.id,
        runId: run.id,
        userId,
        kind,
        name: `${slot}-${tag}`,
        objectKey: `pet/${tag}/${slot}`,
        mime,
        sizeBytes: 1024,
        createdAt,
      },
    });
  const base = await makeArtifact("base", "base_candidate", "image/png", TIE);
  const pkg = await makeArtifact("pkg", "package", "application/zip", at(31));
  const orphanPreview = await makeArtifact("orphan-preview", "animation_preview", "image/png", at(32));
  const orphanBase = await makeArtifact("orphan-base", "base_candidate", "image/png", at(33));
  await prisma.codexPetRun.update({
    where: { id: run.id },
    data: { selectedBaseArtifactId: base.id, packageArtifactId: pkg.id },
  });
  return { project, run, base, pkg, orphanPreview, orphanBase };
}

let seeded: Awaited<ReturnType<typeof seedMainUser>>;
let pet: Awaited<ReturnType<typeof seedCodexPet>>;
let petDeleted: Awaited<ReturnType<typeof seedCodexPet>>;

beforeAll(async () => {
  if (!databaseEnabled) return;
  mainUserId = await createUser("main");
  otherUserId = await createUser("other");
  seeded = await seedMainUser();
  pet = await seedCodexPet(mainUserId, false, `live-${suffix}`);
  petDeleted = await seedCodexPet(mainUserId, true, `dead-${suffix}`);
  // 另一个用户的同类素材：只要有一条漏进来，就是越权。
  await createImage(otherUserId, `req-other-${suffix}`, at(1));
  await seedCodexPet(otherUserId, false, `other-${suffix}`);
  const human = await seedHumanImages(mainUserId);
  await seedHumanImages(otherUserId);
  ids = {
    portrait: `portrait:${human.portrait.id}`,
    tryOn: `try-on:${human.tryOn.id}`,
    bareImage: `image:${seeded.admitted[0]!.id}`,
    articleImage: `image:${seeded.admitted[1]!.id}`,
    ecomMaster: `image:${seeded.admitted[2]!.id}`,
    ecomReference: `image:${seeded.admitted[3]!.id}`,
    noKeyImage: `image:${seeded.admitted[4]!.id}`,
    tieImage: `image:${seeded.admitted[5]!.id}`,
    video: `video:${seeded.video.id}`,
    narration: `audio:${seeded.audios[0]!.id}`,
    bgm: `audio:${seeded.audios[1]!.id}`,
    voiceSample: `audio:${seeded.audios[2]!.id}`,
    excludedAudio: `audio:${seeded.audios[3]!.id}`,
    petBase: `codex-pet:${pet.base.id}`,
    petPackage: `codex-pet:${pet.pkg.id}`,
    petOrphanPreview: `codex-pet:${pet.orphanPreview.id}`,
    petOrphanBase: `codex-pet:${pet.orphanBase.id}`,
    petDeletedBase: `codex-pet:${petDeleted.base.id}`,
  };
});

afterAll(async () => {
  if (!databaseEnabled || userIds.length === 0) return;
  // User 上所有相关关系都是 onDelete: Cascade，删用户即清干净（含桌宠 project/run/artifact）。
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function fullPage(query: Parameters<typeof listAssets>[1] = { userId: "" }): Promise<readonly AssetItem[]> {
  const page = await listAssets(deps, { ...query, userId: query.userId || mainUserId, limit: 100 });
  expect(page.nextCursor).toBeNull();
  return page.items;
}

describe.skipIf(!databaseEnabled)("六个源在真库上的准入", () => {
  it("恰好收下该收的 14 条，一条不多", async () => {
    const items = await fullPage();
    expect([...items.map((item) => item.id)].sort()).toEqual([
      ids.articleImage, ids.bareImage, ids.bgm, ids.ecomMaster, ids.ecomReference,
      ids.narration, ids.noKeyImage, ids.petBase, ids.petPackage, ids.tieImage,
      ids.video, ids.voiceSample, ids.portrait, ids.tryOn,
    ].sort());
  });

  it("恢复的形象照与试穿可独立筛选，并使用各自签名取件链接", async () => {
    for (const sourceModule of ["portrait", "try-on"] as const) {
      const items = await fullPage({ userId: mainUserId, sourceModule });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ sourceModule, mediaType: "image", origin: "ai" });
      expect(items[0]!.url).toMatch(new RegExp(`^${sourceModule}://`));
      expect(items[0]!.thumbnailUrl).toBe(items[0]!.url);
    }
  });

  it("图片：中间件与未知 ecom 前缀都进不来（嵌套 OR/AND/NOT 真能翻成 SQL）", async () => {
    const got = new Set((await fullPage()).map((item) => item.id));
    for (const denied of seeded.denied) expect(got.has(`image:${denied.id}`)).toBe(false);
  });

  it("图片：有 objectKey 走签名链接，没有就回落上游 URL", async () => {
    const byId = new Map((await fullPage()).map((item) => [item.id, item]));
    expect(byId.get(ids.bareImage)?.url).toBe(`img://${seeded.admitted[0]!.id}/obj/req-${suffix}`);
    expect(byId.get(ids.noKeyImage)?.url).toBe(seeded.admitted[4]!.originalUrl);
    expect(byId.get(ids.noKeyImage)?.thumbnailUrl).toBe(seeded.admitted[4]!.thumbnailUrl);
  });

  it("图片：同一张表分裂成四个 module，来源也跟着分", async () => {
    const byId = new Map((await fullPage()).map((item) => [item.id, item]));
    expect(byId.get(ids.bareImage)?.sourceModule).toBe("image");
    expect(byId.get(ids.articleImage)?.sourceModule).toBe("article");
    expect(byId.get(ids.ecomMaster)?.sourceModule).toBe("ecom");
    expect(byId.get(ids.ecomReference)).toMatchObject({ sourceModule: "reference", origin: "upload" });
    expect(byId.get(ids.articleImage)?.groupKey).toBe(`wf-${suffix}`);
  });

  it("音频：三种角色进、其余 kind 不进；bgm/音色样本归「我上传的」", async () => {
    const byId = new Map((await fullPage()).map((item) => [item.id, item]));
    expect(byId.get(ids.narration)?.origin).toBe("ai");
    expect(byId.get(ids.bgm)?.origin).toBe("upload");
    expect(byId.get(ids.voiceSample)?.origin).toBe("upload");
    expect(byId.has(ids.excludedAudio)).toBe(false);
  });

  it("桌宠：只收四个指针指着的 artifact，软删项目整个不进", async () => {
    const got = new Set((await fullPage()).map((item) => item.id));
    expect(got.has(ids.petBase)).toBe(true);
    expect(got.has(ids.petPackage)).toBe(true);
    expect(got.has(ids.petOrphanPreview)).toBe(false);
    expect(got.has(ids.petOrphanBase)).toBe(false);
    expect(got.has(ids.petDeletedBase)).toBe(false);
  });

  it("桌宠：zip 是 archive 而不是图片，项目名做折叠标签", async () => {
    const byId = new Map((await fullPage()).map((item) => [item.id, item]));
    expect(byId.get(ids.petPackage)).toMatchObject({ mediaType: "archive", groupLabel: `桌宠-live-${suffix}` });
    expect(byId.get(ids.petBase)?.mediaType).toBe("image");
    expect(byId.get(ids.petBase)?.url).toBe(`pet://${pet.base.id}`);
  });

  it("只看自己的：两个用户的素材集合完全不相交", async () => {
    const mine = new Set((await fullPage()).map((item) => item.id));
    const otherPage = await listAssets(deps, { userId: otherUserId, limit: 100 });
    // 另一个用户：裸生图、形象照、试穿各 1 张 + base/package 两个 artifact。
    expect(otherPage.items.length).toBe(5);
    expect(otherPage.items.filter((item) => mine.has(item.id))).toEqual([]);
  });
});

describe.skipIf(!databaseEnabled)("真库上的过滤与分页", () => {
  it.each([
    ["video", "video"],
    ["reference", "ecomReference"],
  ] as const)("按 module=%s 过滤只回该 module", async (sourceModule, idKey) => {
    const items = await fullPage({ userId: mainUserId, sourceModule });
    expect(items.map((item) => item.id)).toEqual([ids[idKey]]);
  });

  it("按 origin=upload 过滤：横跨 ImageAsset 与 AudioAsset 两张表", async () => {
    const items = await fullPage({ userId: mainUserId, origin: "upload" });
    expect(items.map((item) => item.id).sort()).toEqual([ids.bgm, ids.ecomReference, ids.voiceSample].sort());
  });

  it("同一毫秒上跨源按前缀定序（try-on: > portrait: > image: > codex-pet:）", async () => {
    const items = await fullPage();
    const tieIds = items.filter((item) => item.createdAt === TIE.toISOString()).map((item) => item.id);
    expect(tieIds).toEqual([ids.tryOn, ids.portrait, ids.tieImage, ids.petBase]);
  });

  it.each([1, 2, 3, 7])("limit=%i 在真 SQL 上翻到底：与单页结果逐条一致", async (limit) => {
    const expected = (await fullPage()).map((item) => item.id);
    const collected: string[] = [];
    let cursor: AssetCursor | null = null;
    for (let guard = 0; guard <= expected.length + 2; guard += 1) {
      const page = await listAssets(deps, { userId: mainUserId, limit, cursor });
      collected.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = decodeAssetCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual(expected);
  });

  it("翻页也认过滤条件（裸生图那三条要逐页续上）", async () => {
    const expected = (await fullPage({ userId: mainUserId, sourceModule: "image" })).map((item) => item.id);
    expect(expected.length).toBe(3);
    const collected: string[] = [];
    let cursor: AssetCursor | null = null;
    for (let guard = 0; guard <= expected.length + 2; guard += 1) {
      const page = await listAssets(deps, { userId: mainUserId, limit: 1, sourceModule: "image", cursor });
      collected.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = decodeAssetCursor(page.nextCursor);
    }
    expect(collected).toEqual(expected);
  });
});

