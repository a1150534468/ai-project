/**
 * 多路归并 + 键集分页。素材库的全部「服务层」就这一个函数。
 *
 * 这里**不认识任何一个具体的源**：源的名单、准入规则、链接怎么签全在 asset-sources.ts。
 * 加一路（P3.3 补 `try-on` 时就是这样）只改那份名单，本文件一个字都不用动。
 */

import { compareAssetKeysDesc, encodeAssetCursor, isBelowCursor } from "./asset-cursor.js";
import { ASSET_SOURCES, type AssetSource, type AssetSourceDeps } from "./asset-sources.js";
import type { AssetCursor, AssetOrigin, AssetPage, AssetSourceModule } from "./asset-types.js";

export const ASSET_PAGE_SIZE_DEFAULT = 30;
export const ASSET_PAGE_SIZE_MAX = 100;

export interface ListAssetsQuery {
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: AssetCursor | null;
  readonly sourceModule?: AssetSourceModule | null;
  readonly origin?: AssetOrigin | null;
}

export function clampAssetPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return ASSET_PAGE_SIZE_DEFAULT;
  return Math.min(Math.max(Math.trunc(raw), 1), ASSET_PAGE_SIZE_MAX);
}

/**
 * `sources` 可注入，测试用假源钉分页行为，不必造七张表的数据。
 *
 * **每源多捞两行**（`limit + 2`）撑起两个判据：
 *   1. 同源的游标那一行会被 `keysetWhere` 连着捞回来（一行可能产出多条素材），由
 *      `isBelowCursor` 逐条筛掉 —— 每个源最多浪费一行窗口。
 *   2. 于是「还有下一页」可以只看 `merged.length > limit`：任何还有剩的源都返回了满窗口
 *      `limit + 2` 行，减掉最多浪费的那一行、每行至少产出一条素材，仍有 `limit + 1` 条，
 *      必然大于 `limit`。反过来，所有源都没填满窗口就是真的到底了。
 */
export async function listAssets(
  deps: AssetSourceDeps,
  query: ListAssetsQuery,
  sources: readonly AssetSource[] = ASSET_SOURCES,
): Promise<AssetPage> {
  const limit = clampAssetPageSize(query.limit);
  const cursor = query.cursor ?? null;
  const sourceModule = query.sourceModule ?? null;
  const origin = query.origin ?? null;
  const active = sources.filter((source) => {
    if (sourceModule && !source.modules.includes(sourceModule)) return false;
    if (origin && !source.origins.includes(origin)) return false;
    return true;
  });
  const batches = await Promise.all(
    active.map((source) => source.fetch(deps, { userId: query.userId, cursor, take: limit + 2, sourceModule, origin })),
  );
  const merged = batches
    .flat()
    .filter((item) => isBelowCursor(item, cursor))
    .sort(compareAssetKeysDesc);
  const items = merged.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: merged.length > limit && last
      ? encodeAssetCursor({ createdAt: new Date(last.createdAt), id: last.id })
      : null,
  };
}
