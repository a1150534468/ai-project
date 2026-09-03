/**
 * 素材库的排序键、游标与键集条件。
 *
 * 键是 `(createdAt desc, id desc)`，**不是 offset**：多路归并 + 新素材随时插到最前面，
 * offset 会同时漏行和重行（见 asset-types.ts 的 AssetCursor）。
 *
 * 下面 `keysetWhere` 的跨源分支依赖一条前缀性质：**任意两个源前缀之间，谁都不是谁的前缀**。
 * 有了它，同一个 `createdAt` 上「本源的行 id 与游标 id 谁大」只由前缀决定，与行 id 无关，
 * 于是可以整段收或整段丢。asset-cursor.test.ts 钉住了这条性质。
 */

import { Buffer } from "node:buffer";
import type { AssetCursor } from "./asset-types.js";

export const ASSET_SOURCE_ID_PREFIXES = {
  image: "image:",
  video: "video:",
  audio: "audio:",
  codexPet: "codex-pet:",
} as const;

export type AssetSourceKey = keyof typeof ASSET_SOURCE_ID_PREFIXES;

/** id 上限：游标是我们自己签发的，但它照样会被人手改后塞回来，别让它变成任意长的 SQL 字面量。 */
const MAX_CURSOR_ID_LENGTH = 200;

export function compareAssetKeysDesc(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 严格在游标之后（降序意义上）。SQL 边界会故意多捞一行，靠这个函数逐条筛掉。 */
export function isBelowCursor(
  item: { readonly createdAt: string; readonly id: string },
  cursor: AssetCursor | null,
): boolean {
  if (!cursor) return true;
  const itemTime = Date.parse(item.createdAt);
  const cursorTime = cursor.createdAt.getTime();
  if (itemTime !== cursorTime) return itemTime < cursorTime;
  return item.id < cursor.id;
}

export function encodeAssetCursor(cursor: AssetCursor): string {
  return Buffer.from(`${cursor.createdAt.getTime()}:${cursor.id}`, "utf8").toString("base64url");
}

/** 解不出来就返回 null（当成没带游标，回到第一页），不抛 —— 游标只影响翻页位置。 */
export function decodeAssetCursor(raw: string): AssetCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  const createdAtMs = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return null;
  if (id.length === 0 || id.length > MAX_CURSOR_ID_LENGTH) return null;
  return { createdAt: new Date(createdAtMs), id };
}

/**
 * 某个源的键集条件。`prefix` 是该源的 id 前缀。
 *
 * 同源用 `lte` 而不是 `lt`：一行可能产出多条素材（口播项目的三个媒体列），游标可能停在
 * 这一行的中间，所以游标那行要连着捞回来，再由 `isBelowCursor` 把已经给过的那几条筛掉。
 * 代价是每页最多浪费一行窗口，换来的是「一行多素材」和「一行一素材」两种源共用一套分页。
 */
export function keysetWhere(cursor: AssetCursor | null, prefix: string): Record<string, unknown> {
  if (!cursor) return {};
  if (cursor.id.startsWith(prefix)) {
    const rowKey = cursor.id.slice(prefix.length);
    return {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lte: rowKey } },
      ],
    };
  }
  return prefix < cursor.id
    ? { createdAt: { lte: cursor.createdAt } }
    : { createdAt: { lt: cursor.createdAt } };
}
