/**
 * 素材库读接口。只有一个端点：`GET /api/assets`。
 *
 * 这里的类型是 `apps/api/src/assets/asset-types.ts` 的手抄件 —— web 与 api 之间没有共享类型包
 * （见 kbApi.ts 等模块的同样做法）。抄的时候两边字段必须逐字对齐，
 * 尤其 `AssetItem` 里那堆 `| null`：服务端给的是 null 而不是 undefined，判空写法不能想当然。
 *
 * 响应是**裸** `{ items, nextCursor }`，没有 `{ success, data }` 外壳；`request()` 两种都吃，
 * 所以这里不需要额外处理。
 */
import { request } from "./http";

/** 与服务端 `ASSET_SOURCE_MODULES` 同序同值。`comic` 当前不会被收进来，但类型要留着（见 assetLibrary.ts）。 */
export const ASSET_SOURCE_MODULES = [
  "image",
  "article",
  "ecom",
  "comic",
  "reference",
  "video",
  "audio",
  "codex-pet",
] as const;

export type AssetSourceModule = (typeof ASSET_SOURCE_MODULES)[number];

/** 来源维度：页面的两个分区就是它。 */
export type AssetOrigin = "ai" | "upload";

export type AssetMediaType = "image" | "video" | "audio" | "archive";

export interface AssetItem {
  /** `<源前缀>:<行 id>`。前端只当不透明字符串用，别去解析它。 */
  readonly id: string;
  readonly sourceModule: AssetSourceModule;
  readonly origin: AssetOrigin;
  readonly mediaType: AssetMediaType;
  readonly title: string;
  /** 取件地址。素材库不新开取件端点，所以拿不到链接（缺 objectKey 等）时是 null，此时不给下载入口。 */
  readonly url: string | null;
  readonly thumbnailUrl: string | null;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number | null;
  readonly durationSec: number | null;
  readonly createdAt: string;
  readonly groupKey: string | null;
  readonly groupLabel: string | null;
}

export interface AssetPage {
  readonly items: readonly AssetItem[];
  /** null = 到底了。前端据此收掉「加载更多」。 */
  readonly nextCursor: string | null;
}

export interface ListAssetsQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly sourceModule?: AssetSourceModule | null;
  readonly origin?: AssetOrigin | null;
}

/**
 * 拉一页素材。空值一律不进 query string —— 服务端 `cursor` 的下限是 1 个字符，
 * 传 `cursor=` 会被判成参数不合法（400），而我们的语义是「回第一页」。
 */
export function listAssets(token: string, query: ListAssetsQuery = {}): Promise<AssetPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.sourceModule) params.set("sourceModule", query.sourceModule);
  if (query.origin) params.set("origin", query.origin);
  const search = params.toString();
  return request(`/api/assets${search ? `?${search}` : ""}`, { token, fallback: "获取素材库失败" });
}
