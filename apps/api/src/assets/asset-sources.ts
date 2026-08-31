/**
 * 七个源适配器。每个把一张权威表的行翻成 `AssetItem`，**不新建表、不新开取件端点**。
 *
 * 三条贯穿全文件的约束：
 *
 * 1. **URL 一律问原模块要。** 图片走 `imageBlobUrl`、形象照走 `portraitBlobUrl`、试穿走
 *    `tryOnBlobUrl`、宣传片音频走 `projectAudioBlobUrl`、桌宠走 `defaultArtifactPreviewUrl`，
 *    视频/口播本来就存的是可直接播的 URL。素材库自己签一条链接就等于第二套访问控制。
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
import { imageBlobUrl } from "../workflow/image/image-route-helpers.js";
import { projectAudioBlobUrl } from "../workflow/local-business-promo/local-business-promo-media-access.js";
import { portraitBlobUrl } from "../workflow/portrait/portrait-routes.js";
import { tryOnBlobUrl } from "../workflow/try-on/try-on-routes.js";
import { classifyImageRequestId, imageAdmissionWhere, imageGroupKey } from "./asset-classify.js";
import { ASSET_SOURCE_ID_PREFIXES, keysetWhere } from "./asset-cursor.js";
import type { AssetCursor, AssetItem, AssetOrigin, AssetSourceModule } from "./asset-types.js";

export interface AssetSourceDeps {
  readonly prisma: PrismaClient;
  readonly imageBlobUrl: (imageId: string, objectKey: string) => string;
  readonly portraitBlobUrl: (outputId: string, objectKey: string) => string;
  readonly tryOnBlobUrl: (outputId: string, objectKey: string) => string;
  readonly projectAudioBlobUrl: (projectId: string, objectKey: string, mime: string) => string;
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
 * `bgm` 归「我上传的」是按角色定的：它也可能来自内置预设（`source='local-bgm'`，
 * local-business-promo-audio-bgm-routes.ts:59）而不是真的上传，但对用户来说
 * 两者都是「我挑进来的背景音乐」，不是 AI 生成物。
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
        // 与 serializeAudioAsset 同一套回落（local-business-promo-route-helpers.ts:98）。
        url: row.objectKey && row.projectId
          ? deps.projectAudioBlobUrl(row.projectId, row.objectKey, row.mime)
          : row.originalUrl,
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
 * 口播项目的三个媒体列（计划裁定表第 4 行）：**只进媒体那半，`script` 不进**。
 * 一行最多产出三条素材，所以 id 要再带一段媒体列名 —— 键集分页对「一行多素材」的处理
 * 见 asset-cursor.ts 的 `keysetWhere`。
 */
const DUB_MEDIA_SLOTS = [
  { slot: "final", label: "口播成品视频", mediaType: "video", fallbackMime: "video/mp4" },
  { slot: "result", label: "口播成片（混流前）", mediaType: "video", fallbackMime: "video/mp4" },
  { slot: "audio", label: "口播配音", mediaType: "audio", fallbackMime: "audio/wav" },
] as const;

const URL_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** 口播那三列只存 URL、没有 mime 列，只能按扩展名认；认不出来用槽位默认值。 */
function mimeFromUrl(url: string, fallback: string): string {
  const extension = url.split("?")[0]?.split(".").pop()?.toLowerCase();
  return (extension && URL_MIME_BY_EXTENSION[extension]) || fallback;
}

const dubSource: AssetSource = {
  key: "dub",
  modules: ["dub"],
  origins: ["ai"],
  fetch: async (deps, query) => {
    const rows = await deps.prisma.dubProject.findMany({
      where: {
        userId: query.userId,
        AND: [
          { OR: [{ finalVideoUrl: { not: null } }, { resultVideoUrl: { not: null } }, { audioUrl: { not: null } }] },
          keysetWhere(query.cursor, P.dub),
        ],
      },
      orderBy: [...ROW_ORDER],
      take: query.take,
      select: {
        id: true,
        title: true,
        audioUrl: true,
        audioDurationSec: true,
        resultVideoUrl: true,
        finalVideoUrl: true,
        createdAt: true,
      },
    });
    return rows.flatMap((row) => {
      const urls = { final: row.finalVideoUrl, result: row.resultVideoUrl, audio: row.audioUrl };
      return DUB_MEDIA_SLOTS.flatMap((media) => {
        const url = urls[media.slot];
        if (!url) return [];
        return [{
          id: `${P.dub}${row.id}:${media.slot}`,
          sourceModule: "dub" as const,
          origin: "ai" as const,
          mediaType: media.mediaType,
          title: `${assetTitle(row.title, "未命名口播")} · ${media.label}`,
          url,
          thumbnailUrl: null,
          mime: mimeFromUrl(url, media.fallbackMime),
          width: null,
          height: null,
          sizeBytes: null,
          durationSec: media.slot === "audio" ? row.audioDurationSec : null,
          // 项目 createdAt 而不是 updatedAt：改一次标题就换一次排序键的话，翻页会漏行也会重行。
          createdAt: row.createdAt.toISOString(),
          groupKey: row.id,
          groupLabel: assetTitle(row.title, "未命名口播"),
        }];
      });
    });
  },
};

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
  videoSource,
  audioSource,
  dubSource,
  portraitSource,
  tryOnSource,
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
    portraitBlobUrl: (outputId, objectKey) => portraitBlobUrl("output", outputId, objectKey),
    tryOnBlobUrl: (outputId, objectKey) => tryOnBlobUrl("output", outputId, objectKey),
    projectAudioBlobUrl,
    // 非光栅图（交付包 zip）拿不到预览链接，取件仍走桌宠自己那条限流的安装链接接口。
    codexPetArtifactUrl: (artifact) => defaultArtifactPreviewUrl(artifact, {}),
  };
}
