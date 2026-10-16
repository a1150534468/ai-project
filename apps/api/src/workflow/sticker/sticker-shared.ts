/**
 * 表情包工坊：共享常量与纯函数。
 *
 * 贴纸本身复用 `ImageAsset`（按 pack.requestId + requestIndex 聚合），
 * 这里只维护 pack 级别的状态机与 16 个预设表情模板。
 */
import { randomUUID } from "node:crypto";

export const STICKER_PACK_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
} as const;

export type StickerPackStatus = (typeof STICKER_PACK_STATUS)[keyof typeof STICKER_PACK_STATUS];

export const STICKER_PACK_FINAL_STATUSES: ReadonlySet<string> = new Set([
  STICKER_PACK_STATUS.completed,
  STICKER_PACK_STATUS.failed,
]);

export const STICKER_STYLE = {
  cute: "cute",
} as const;

export type StickerStyle = (typeof STICKER_STYLE)[keyof typeof STICKER_STYLE];

export interface StickerPreset {
  readonly key: string;
  readonly label: string;
  /** 英文动作/表情描述，拼进生图 prompt */
  readonly prompt: string;
}

/**
 * 16 个预设表情/动作，对齐微信表情包一组的常见数量。
 * v1 不支持自定义模板。
 */
export const STICKER_PRESETS: readonly StickerPreset[] = [
  { key: "happy", label: "开心大笑", prompt: "laughing happily with a big open smile" },
  { key: "cry", label: "大哭", prompt: "crying loudly with big tears streaming down" },
  { key: "angry", label: "生气", prompt: "angry with puffed cheeks and furrowed brows" },
  { key: "like", label: "点赞", prompt: "giving a big thumbs up" },
  { key: "love", label: "比心", prompt: "making a heart shape with both hands" },
  { key: "fighting", label: "加油", prompt: "cheering with a raised fist, full of energy" },
  { key: "ok", label: "OK", prompt: "making an OK hand gesture" },
  { key: "question", label: "问号", prompt: "tilting head with a big question mark above, confused" },
  { key: "sleep", label: "睡觉", prompt: "sleeping peacefully with a nightcap, Zzz floating" },
  { key: "melon", label: "吃瓜", prompt: "eating a big slice of watermelon, enjoying gossip" },
  { key: "clap", label: "鼓掌", prompt: "clapping hands enthusiastically" },
  { key: "hug", label: "抱抱", prompt: "opening arms wide asking for a hug" },
  { key: "despise", label: "鄙视", prompt: "side-eyeing with a disdainful expression" },
  { key: "shy", label: "害羞", prompt: "blushing shyly, covering face with hands" },
  { key: "surprised", label: "惊讶", prompt: "gasping in surprise with wide eyes and open mouth" },
  { key: "bye", label: "再见", prompt: "waving goodbye with a smile" },
];

const STICKER_PRESET_KEYS = new Set(STICKER_PRESETS.map((preset) => preset.key));

export function isStickerPresetKey(key: string): boolean {
  return STICKER_PRESET_KEYS.has(key);
}

export function stickerPresetByKey(key: string): StickerPreset | null {
  return STICKER_PRESETS.find((preset) => preset.key === key) ?? null;
}

/** 风格后缀：所有贴纸统一的可爱贴纸风，保证一组成套感。 */
export function stickerStyleSuffix(style: string): string {
  void style;
  return "cute cartoon sticker style, thick white outline, centered composition, plain solid light background";
}

/** 拼出某张贴纸的完整生图 prompt。 */
export function buildStickerPrompt(characterPrompt: string, preset: StickerPreset, style: string): string {
  const character = characterPrompt.trim();
  return [
    `Keep the exact same character as the reference image: ${character}.`,
    `Now the character is ${preset.prompt}.`,
    `${stickerStyleSuffix(style)}.`,
    "Single character only, no text, no watermark.",
  ].join(" ");
}

/** 主形象生成的 prompt（文字描述模式）。 */
export function buildBaseCharacterPrompt(characterPrompt: string, style: string): string {
  return [
    `${characterPrompt.trim()}, full body character portrait, front facing, neutral happy expression.`,
    `${stickerStyleSuffix(style)}.`,
    "Single character only, no text, no watermark.",
  ].join(" ");
}

/** 卡单阈值（毫秒）：租约过期多久后 reaper 判定为卡单。 */
export function loadStickerStaleTaskMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STICKER_STALE_TASK_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  // 16 张逐张生成，单张可能耗时 1~2 分钟；阈值放宽到 20 分钟。
  return 20 * 60 * 1000;
}

/** 新建 pack 用的 requestId。 */
export function newStickerRequestId(): string {
  return `sticker_${randomUUID().replace(/-/g, "")}`;
}

export interface StickerPackRow {
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
