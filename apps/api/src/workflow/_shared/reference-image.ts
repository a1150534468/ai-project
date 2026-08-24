import { Buffer } from "node:buffer";
import type { getPrisma } from "@ai-assistant/db";

const DATA_URL_PATTERN = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/;

/**
 * 内联参考图。结构上兼容 ecom 的 `InlineImageInput`（`{ b64, mime? }`），
 * 但这里故意不 import 那个类型 —— `_shared` 不该反向依赖某个域。
 */
export type InlineImage = {
  readonly mime: string;
  readonly b64: string;
};

/** 把一张已存图资产读成内联 base64：data URL 直接拆，否则按 originalUrl 下载。 */
export async function loadReferenceImage(
  asset: { readonly originalUrl: string; readonly mime: string },
  fetchFn: typeof fetch,
): Promise<InlineImage> {
  const inline = DATA_URL_PATTERN.exec(asset.originalUrl);
  if (inline) return { mime: inline[1], b64: inline[2] };
  const response = await fetchFn(asset.originalUrl, { method: "GET" });
  if (!response.ok) throw new Error(`reference download ${response.status}`);
  const mime = response.headers.get("content-type")?.trim() || asset.mime || "image/png";
  return {
    mime: mime.startsWith("image/") ? mime : "image/png",
    b64: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

/** 按 assetIds 顺序加载本人名下的参考图；有一张不属于本人或不存在就整体报错。 */
export async function loadOwnedReferenceImages(
  prisma: ReturnType<typeof getPrisma>,
  userId: string,
  assetIds: readonly string[],
  fetchFn: typeof fetch,
): Promise<InlineImage[]> {
  const assets = await prisma.imageAsset.findMany({ where: { userId, id: { in: [...assetIds] } } });
  if (assets.length !== assetIds.length) throw new Error("reference asset missing");
  return Promise.all(assetIds.map(async (assetId) => {
    const asset = assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("reference asset missing");
    return loadReferenceImage(asset, fetchFn);
  }));
}
