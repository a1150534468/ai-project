/**
 * 素材库读模型的类型层。
 *
 * 素材库**不建表**（见 docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md
 * 「素材库不建新表」一节）：它是 ImageAsset / PortraitOutput / TryOnOutput / VideoAsset / AudioAsset / CodexPetRun 等
 * 权威表的聚合读模型。查不到就是没有，源删则自然消失，孤儿结构性地不可能存在 —— 这正是
 * 知识库那 335 行归档触发器付出代价才没换到的性质。
 *
 * `comic` / `ecom` / `reference` 三个 module 由 `ImageAsset.requestId` 前缀裁定（见
 * asset-classify.ts）。电商已恢复，其他已下线场景的存量行仍保留原准入规则 ——
 * 摘掉规则会让 `ecom-stitch:` 这类中间件掉进兜底规则、反而混进素材库。
 */

/** 素材归属的工作流。`reference` 不是工作流，见 asset-classify.ts 的说明。 */
export const ASSET_SOURCE_MODULES = [
  "image",
  "portrait",
  "try-on",
  "article",
  "ecom",
  "comic",
  "reference",
  "video",
  "audio",
  "codex-pet",
] as const;

export type AssetSourceModule = (typeof ASSET_SOURCE_MODULES)[number];

/** 来源维度。前端按这个分「AI 生成 / 我上传的」两区。 */
export type AssetOrigin = "ai" | "upload";

export type AssetMediaType = "image" | "video" | "audio" | "archive";

export interface AssetItem {
  /**
   * 全局唯一：`<源前缀>:<权威表行 id>`（口播项目再加 `:<媒体列>`）。跨表 id 可能重名，
   * 不加前缀会撞。前缀是**源**而不是 `sourceModule`：`ImageAsset` 一张表会产出
   * image/article/ecom/reference 四种 module，拿 module 当前缀的话，同一个源的行在全局
   * 序里前缀就不一样，键集分页无从下手；而且改一条准入规则会让老素材换 id。见 asset-cursor.ts。
   */
  readonly id: string;
  readonly sourceModule: AssetSourceModule;
  readonly origin: AssetOrigin;
  readonly mediaType: AssetMediaType;
  readonly title: string;
  /**
   * 播放/下载地址。**一律复用各模块自己的签名链路**，素材库不新开取件端点 ——
   * 新开一个就是第二套访问控制，和「建新表就是第三份副本」同一种错。
   * 拿不到（缺 objectKey、或该模块的取件要走另一条限流路由）时为 null。
   */
  readonly url: string | null;
  readonly thumbnailUrl: string | null;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number | null;
  readonly durationSec: number | null;
  readonly createdAt: string;
  /** 归属的项目/运行 id（文章项目、口播项目、桌宠 run），用于前端折叠。 */
  readonly groupKey: string | null;
  readonly groupLabel: string | null;
}

export interface AssetPage {
  readonly items: readonly AssetItem[];
  /** 下一页游标；null 表示到底了。 */
  readonly nextCursor: string | null;
}

/**
 * 键集游标：`(createdAt, id)` 降序。用 offset 分页在这里是错的 ——
 * 多路归并 + 新素材随时插到最前面，offset 会漏行也会重行。
 */
export interface AssetCursor {
  readonly createdAt: Date;
  readonly id: string;
}
