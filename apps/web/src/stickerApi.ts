/** 表情包工坊：前端 API 客户端。 */
import { request } from "./http";

export interface StickerPack {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly name: string;
  readonly characterPrompt: string;
  readonly style: string;
  readonly referenceObjectKey: string | null;
  readonly baseImageRequestId: string | null;
  readonly presetKeys: readonly string[];
  readonly status: string;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StickerAsset {
  readonly id: string;
  readonly requestIndex: number;
  readonly thumbnailUrl: string;
  readonly originalUrl: string;
  readonly mime: string;
}

export interface StickerPreset {
  readonly key: string;
  readonly label: string;
  readonly prompt: string;
}

export interface StickerPackDetail {
  readonly pack: StickerPack;
  readonly stickers: readonly StickerAsset[];
  readonly baseAsset: { readonly id: string; readonly thumbnailUrl: string; readonly originalUrl: string } | null;
  readonly presets: readonly StickerPreset[];
}

export async function createStickerPack(
  token: string,
  input: {
    readonly name?: string;
    readonly characterPrompt: string;
    readonly referenceObjectKey?: string | null;
    readonly presetKeys?: readonly string[];
  },
): Promise<StickerPack> {
  const { pack } = await request<{ pack: StickerPack }>("/api/workflow/sticker/packs", {
    method: "POST",
    token,
    body: {
      name: input.name,
      characterPrompt: input.characterPrompt,
      referenceObjectKey: input.referenceObjectKey ?? null,
      presetKeys: input.presetKeys,
    },
    fallback: "创建表情包任务失败",
  });
  return pack;
}

export async function runStickerPack(token: string, packId: string): Promise<void> {
  await request(`/api/workflow/sticker/packs/${packId}/run`, {
    method: "POST",
    token,
    fallback: "启动生成失败",
  });
}

export async function retryStickerPack(token: string, packId: string): Promise<void> {
  await request(`/api/workflow/sticker/packs/${packId}/retry`, {
    method: "POST",
    token,
    fallback: "重试失败",
  });
}

export async function listStickerPacks(token: string): Promise<StickerPack[]> {
  const { packs } = await request<{ packs: StickerPack[] }>("/api/workflow/sticker/packs", {
    token,
    fallback: "加载表情包列表失败",
  });
  return packs ?? [];
}

export async function getStickerPack(token: string, packId: string): Promise<StickerPackDetail> {
  return await request<StickerPackDetail>(`/api/workflow/sticker/packs/${packId}`, {
    token,
    fallback: "加载表情包详情失败",
  });
}

export async function deleteStickerPack(token: string, packId: string): Promise<void> {
  await request(`/api/workflow/sticker/packs/${packId}`, {
    method: "DELETE",
    token,
    fallback: "删除失败",
  });
}

export async function uploadStickerReference(token: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const { referenceObjectKey } = await request<{ referenceObjectKey: string }>(
    "/api/workflow/sticker/reference-upload",
    { method: "POST", token, body: form, fallback: "参考图上传失败" },
  );
  return referenceObjectKey;
}
