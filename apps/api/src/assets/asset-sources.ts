/**
 * 各个源适配器。每个把一张权威表的行翻成 `AssetItem`，**不新建表、不新开取件端点**。
 *
 * 三条贯穿全文件的约束：
 *
 * 1. **URL 一律问原模块要。** 图片走 `imageBlobUrl`、桌宠走 `defaultArtifactPreviewUrl`，
 *    视频/音频本来就存的是可直接播的 URL。素材库自己签一条链接就等于第二套访问控制。
 * 2. **准入条件必须落在 SQL 里。** 见 asset-classify.ts 的 `imageAdmissionWhere`：拉回内存
 *    再筛会让分页的「见底」判据失效。所以「音频按 kind 分区」也写成 `kind: { in: [...] }`，
 *    「口播只要有媒体列的项目」也写成 `OR` 而不是取回来再挑。
 * 3. **每个源自己保证「返回行数没填满窗口 ⇒ 我见底了」。** 违反这条的只有桌宠：它的准入
 *    是「被 run 的四个指针之一指着」，Prisma 表达不了列与列比较，所以那个源走 `$queryRawUnsafe`
 *    做 JOIN，而不是取回来在内存里筛。
 */

import type { PrismaClient } from "@ai-assistant/db";
import { defaultArtifactPreviewUrl, isSafeRasterImageMime } from "../workflow/codex-pet/codex-pet-route-helpers.js";
import type { CodexPetArtifactShape } from "../workflow/codex-pet/codex-pet-route-types.js";
import { portraitBlobUrl } from "../workflow/portrait/portrait-routes.js";
import { tryOnBlobUrl } from "../workflow/try-on/try-on-routes.js";
import { imageBlobUrl } from "../workflow/image/image-route-helpers.js";
import { classifyImageRequestId, imageAdmissionWhere, imageGroupKey } from "./asset-classify.js";
import { ASSET_SOURCE_ID_PREFIXES, keysetWhere } from "./asset-cursor.js";
import type { AssetCursor, AssetItem, AssetOrigin, AssetSourceModule } from "./asset-types.js";

export interface AssetSourceDeps {
  readonly prisma: PrismaClient;
  readonly portraitBlobUrl: (outputId: string, objectKey: string) => string;
  readonly tryOnBlobUrl: (outputId: string, objectKey: string) => string;
  readonly imageBlobUrl: (imageId: string, objectKey: string) => string;
  readonly codexPetArtifactUrl: (artifact: CodexPetArtifactRow) => string | null;
}

export interface AssetSourceQuery {
  readonly userId: string;
  readonly cursor: AssetCursor | null;
  readonly take: number;
  readonly sourceModule: AssetSourceModule | null;
  readonly origin: AssetOrigin | null;
}

export interface AssetSource {
  readonly key: string;
  /** 这个源可能产出的 module；按 module 过滤时用来整源跳过。 */
  readonly modules: readonly AssetSourceModule[];
  /** 同上，按来源分区时用来整源跳过。 */
  readonly origins: readonly AssetOrigin[];
  readonly fetch: (deps: AssetSourceDeps, query: AssetSourceQuery) => Promise<readonly AssetItem[]>;
}

const P = ASSET_SOURCE_ID_PREFIXES;

const portraitSource: AssetSource = {
  key: "portrait",
  modules: ["portrait"],
  origins: ["ai"],
  fetch: async (deps, query) => {
    const rows = await deps.prisma.portraitOutput.findMany({
      where: { userId: query.userId, AND: [keysetWhere(query.cursor, P.portrait)] },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: {
        id: true,
        taskId: true,
        requestIndex: true,
        objectKey: true,
        mime: true,
        width: true,
        height: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    // 形象照没有单独的缩略图，与 portrait-routes.ts 的 serializeOutput 一样只有一条签名链接。
    return rows.map((row) => {
      const url = deps.portraitBlobUrl(row.id, row.objectKey);
      return {
        id: `${P.portrait}${row.id}`,
        sourceModule: "portrait" as const,
        origin: "ai" as const,
        mediaType: "image" as const,
        title: `形象照 #${row.requestIndex + 1}`,
        url,
        thumbnailUrl: url,
        mime: row.mime,
        width: row.width,
        height: row.height,
        sizeBytes: row.sizeBytes,
        durationSec: null,
        createdAt: row.createdAt.toISOString(),
        groupKey: row.taskId,
        groupLabel: null,
      };
    });
  },
};

/**
 * 试穿输出与形象照同构（同样是 `taskId` + `requestIndex` + 唯一 `objectKey`），所以这一路是
 * portrait 那一路的镜像。但 `sourceModule` 是独立的 `try-on` 而不是并进 `portrait`：
 * 后台菜单里两者本来就是两个三级菜单（`workflow.image.portrait` / `workflow.image.try-on`），
 * 找试穿结果的人不该去「形象照」筛选项下面翻。
 */
const tryOnSource: AssetSource = {
  key: "tryOn",
  modules: ["try-on"],
  origins: ["ai"],
  fetch: async (deps, query) => {
    const rows = await deps.prisma.tryOnOutput.findMany({
      where: { userId: query.userId, AND: [keysetWhere(query.cursor, P.tryOn)] },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: {
        id: true,
        taskId: true,
        requestIndex: true,
        objectKey: true,
        mime: true,
        width: true,
        height: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    // 与 try-on-routes.ts 的 serializeOutput 一样：只有一条签名链接，没有单独的缩略图。
    return rows.map((row) => {
      const url = deps.tryOnBlobUrl(row.id, row.objectKey);
      return {
        id: `${P.tryOn}${row.id}`,
        sourceModule: "try-on" as const,
        origin: "ai" as const,
        mediaType: "image" as const,
        title: `试穿结果 #${row.requestIndex + 1}`,
        url,
        thumbnailUrl: url,
        mime: row.mime,
        width: row.width,
        height: row.height,
        sizeBytes: row.sizeBytes,
        durationSec: null,
        createdAt: row.createdAt.toISOString(),
        groupKey: row.taskId,
        groupLabel: null,
      };
    });
  },
};



const MAX_TITLE_LENGTH = 80;

function assetTitle(raw: string | null | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH)}…` : trimmed;
}

const IMAGE_FALLBACK_TITLES: Record<string, string> = {
  image: "生成图片",
  article: "文章配图",
  ecom: "电商图",
  reference: "参考图",
};

/** 一行一条素材的源共用的排序：与 asset-cursor.ts 的全局键同序。 */
const ROW_ORDER = [{ createdAt: "desc" }, { id: "desc" }] as const;

const imageSource: AssetSource = {
  key: "image",
  modules: ["image", "article", "ecom", "reference"],
  origins: ["ai", "upload"],
  fetch: async (deps, query) => {
    const rows = await deps.prisma.imageAsset.findMany({
      // AND 数组而不是展开：两个条件都可能带 OR，展开会互相覆盖。
      where: {
        userId: query.userId,
        AND: [
          imageAdmissionWhere({ sourceModule: query.sourceModule, origin: query.origin }),
          keysetWhere(query.cursor, P.image),
        ],
      },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: {
        id: true,
        requestId: true,
        prompt: true,
        originalUrl: true,
        thumbnailUrl: true,
        objectKey: true,
        mime: true,
        width: true,
        height: true,
        createdAt: true,
      },
    });
    return rows.map((row) => {
      const rule = classifyImageRequestId(row.requestId);
      // 与 serializeImageRow 同一套回落：有 objectKey 走签名链接，否则原样给上游 URL。
      const blobUrl = row.objectKey ? deps.imageBlobUrl(row.id, row.objectKey) : null;
      return {
        id: `${P.image}${row.id}`,
        sourceModule: rule.sourceModule,
        origin: rule.origin,
        mediaType: "image" as const,
        title: assetTitle(row.prompt, IMAGE_FALLBACK_TITLES[rule.sourceModule] ?? "图片"),
        url: blobUrl ?? row.originalUrl,
        thumbnailUrl: blobUrl ?? row.thumbnailUrl,
        mime: row.mime,
        width: row.width,
        height: row.height,
        sizeBytes: null,
        durationSec: null,
        createdAt: row.createdAt.toISOString(),
        groupKey: imageGroupKey(row.requestId, rule),
        groupLabel: null,
      };
    });
  },
};

const videoSource: AssetSource = {
  key: "video",
  modules: ["video"],
  origins: ["ai"],
  fetch: async (deps, query) => {
    const rows = await deps.prisma.videoAsset.findMany({
      where: { userId: query.userId, AND: [keysetWhere(query.cursor, P.video)] },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: { id: true, prompt: true, originalUrl: true, mime: true, durationSec: true, createdAt: true },
    });
    // 生成视频没有签名取件路由，`originalUrl` 本来就是可直接播的地址
    // （video-route-serialize.ts 也是原样交出去的），这里跟着它。
    return rows.map((row) => ({
      id: `${P.video}${row.id}`,
      sourceModule: "video" as const,
      origin: "ai" as const,
      mediaType: "video" as const,
      title: assetTitle(row.prompt, "生成视频"),
      url: row.originalUrl,
      thumbnailUrl: null,
      mime: row.mime,
      width: null,
      height: null,
      sizeBytes: null,
      durationSec: row.durationSec,
      createdAt: row.createdAt.toISOString(),
      groupKey: null,
      groupLabel: null,
    }));
  },
};

/**
 * 音频的三种角色（计划「音频的三种角色」一节）。表里没列出的 kind **不进** ——
 * 与未知 `ecom-` 前缀同一个取向：宁可漏，不要把中间件塞进用户素材库。
 *
 * 这三种 kind 的生产者（宣传片剪辑）随 Phase 1 下线，`AudioAsset` 表按方案保留 ——
 * 所以这一路现在只读得到存量行，规则表原样留着给将来的生产者用。
 */
const AUDIO_KIND_RULES: Record<string, { readonly origin: AssetOrigin; readonly label: string }> = {
  narration: { origin: "ai", label: "AI 旁白" },
  bgm: { origin: "upload", label: "背景音乐" },
  "voice-sample": { origin: "upload", label: "音色样本" },
};

function metadataFilename(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const filename = (value as Record<string, unknown>).filename;
  return typeof filename === "string" ? filename : null;
}

const audioSource: AssetSource = {
  key: "audio",
  modules: ["audio"],
  origins: ["ai", "upload"],
  fetch: async (deps, query) => {
    const kinds = Object.entries(AUDIO_KIND_RULES)
      .filter(([, rule]) => !query.origin || rule.origin === query.origin)
      .map(([kind]) => kind);
    const rows = await deps.prisma.audioAsset.findMany({
      where: { userId: query.userId, kind: { in: kinds }, AND: [keysetWhere(query.cursor, P.audio)] },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: {
        id: true,
        projectId: true,
        kind: true,
        originalUrl: true,
        objectKey: true,
        mime: true,
        durationSec: true,
        textContent: true,
        metadata: true,
        createdAt: true,
      },
    });
    return rows.map((row) => {
      const rule = AUDIO_KIND_RULES[row.kind];
      return {
        id: `${P.audio}${row.id}`,
        sourceModule: "audio" as const,
        origin: rule?.origin ?? "ai",
        mediaType: "audio" as const,
        title: assetTitle(metadataFilename(row.metadata) ?? row.textContent, rule?.label ?? "音频"),
        // 原来 objectKey + projectId 走的是宣传片自己的签名路由，那个模块随 Phase 1 下线，
        // 素材库不新开取件端点（见文件头第 1 条），所以只剩 originalUrl 一条路。
        url: row.originalUrl,
        thumbnailUrl: null,
        mime: row.mime,
        width: null,
        height: null,
        sizeBytes: null,
        durationSec: row.durationSec,
        createdAt: row.createdAt.toISOString(),
        groupKey: row.projectId,
        groupLabel: null,
      };
    });
  },
};

/**
 * 桌宠只收 `CodexPetRun` 四个指针列指着的那几个 artifact（计划裁定表最后一行：
 * 「run 已经声明了哪几个 artifact 是有意义的，素材库直接用这四个指针，不要扫全表」）。
 *
 * **不能用计划正文那份 kind 白名单**：`final_package` 这个 kind 在库里根本不存在，而
 * `animation_preview` 有 691 行、其中被四个指针引用的是 **0** 行 —— 按 kind 收会多收 691 条
 * 中间件（约 14 倍）。被指针指着的四种 kind 实测：`base_candidate` 79/84、`package` 48/50、
 * `spritesheet` 48/50、`preview` 48/50。
 *
 * 这里走 `$queryRawUnsafe` 是**被迫的**：准入条件是「artifact.id 等于 run 上四个列之一」，
 * 列与列的比较 Prisma 表达不了。取回来再在内存里筛会违反本文件第 3 条约束（分页判不出见底），
 * 所以宁可写 JOIN。参数全部走占位符，与 kb/retrieve.ts 一致。
 */
export type CodexPetArtifactRow = CodexPetArtifactShape & { readonly projectName: string };

const CODEX_PET_KIND_LABELS: Record<string, string> = {
  base_candidate: "桌宠基础形象",
  spritesheet: "桌宠精灵图",
  package: "桌宠交付包",
  preview: "桌宠预览图",
};

const codexPetSource: AssetSource = {
  key: "codexPet",
  modules: ["codex-pet"],
  origins: ["ai"],
  fetch: async (deps, query) => {
    const params: unknown[] = [query.userId];
    const conditions: string[] = [];
    if (query.cursor) {
      if (query.cursor.id.startsWith(P.codexPet)) {
        params.push(query.cursor.createdAt, query.cursor.id.slice(P.codexPet.length));
        const time = `$${params.length - 1}`;
        conditions.push(`(a."createdAt" < ${time} OR (a."createdAt" = ${time} AND a.id <= $${params.length}))`);
      } else {
        params.push(query.cursor.createdAt);
        conditions.push(`a."createdAt" ${P.codexPet < query.cursor.id ? "<=" : "<"} $${params.length}`);
      }
    }
    params.push(query.take);
    const rows = await deps.prisma.$queryRawUnsafe<readonly CodexPetArtifactRow[]>(
      `SELECT a.id, a."userId", a."projectId", a."runId", a."jobId", a.kind, a.name, a.status,
              a."objectKey", a.mime, a."sizeBytes", a.width, a.height, a.metadata,
              a."expiresAt", a."createdAt", p.name AS "projectName"
         FROM "CodexPetArtifact" a
         JOIN "CodexPetRun" r ON r.id = a."runId"
         JOIN "CodexPetProject" p ON p.id = a."projectId"
        WHERE a."userId" = $1
          AND p."deletedAt" IS NULL
          AND a.id IN (r."selectedBaseArtifactId", r."spritesheetArtifactId",
                       r."packageArtifactId", r."previewArtifactId")
          ${conditions.map((condition) => `AND ${condition}`).join("\n          ")}
        ORDER BY a."createdAt" DESC, a.id DESC
        LIMIT $${params.length}`,
      ...params,
    );
    return rows.map((row) => {
      const url = deps.codexPetArtifactUrl(row);
      return {
        id: `${P.codexPet}${row.id}`,
        sourceModule: "codex-pet" as const,
        origin: "ai" as const,
        // 交付包是 zip，没有预览也不该被当成图片渲染。
        mediaType: isSafeRasterImageMime(row.mime) ? ("image" as const) : ("archive" as const),
        title: assetTitle(row.name, CODEX_PET_KIND_LABELS[row.kind] ?? row.kind),
        url,
        thumbnailUrl: url,
        mime: row.mime,
        width: row.width,
        height: row.height,
        sizeBytes: row.sizeBytes,
        durationSec: null,
        createdAt: row.createdAt.toISOString(),
        groupKey: row.projectId,
        groupLabel: assetTitle(row.projectName, "桌宠项目"),
      };
    });
  },
};

/** 顺序只影响并发发起的次序，归并按全局键重排。 */
export const ASSET_SOURCES: readonly AssetSource[] = [
  imageSource,
  portraitSource,
  tryOnSource,
  videoSource,
  audioSource,
  codexPetSource,
];

/**
 * 生产接线：**每条链接都是原模块自己的签名函数**，素材库一条都没自己签。
 * 测试可以整份替换这些函数，从而不依赖任何签名密钥。
 */
export function createAssetSourceDeps(prisma: PrismaClient): AssetSourceDeps {
  return {
    prisma,
    imageBlobUrl,
    portraitBlobUrl: (id, key) => portraitBlobUrl("output", id, key),
    tryOnBlobUrl: (id, key) => tryOnBlobUrl("output", id, key),
    // 非光栅图（交付包 zip）拿不到预览链接，取件仍走桌宠自己那条限流的安装链接接口。
    codexPetArtifactUrl: (artifact) => defaultArtifactPreviewUrl(artifact, {}),
  };
}
