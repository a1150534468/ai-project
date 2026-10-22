import { z } from "zod";
import { isStickerPresetKey, STICKER_PRESETS } from "./sticker-shared.js";

export const MAX_STICKER_CHARACTER_PROMPT_LENGTH = 500;
export const MAX_STICKER_NAME_LENGTH = 80;
export const MAX_STICKER_PRESETS_PER_PACK = 24;

export const stickerPackCreateSchema = z.object({
  // name 不设 max：原行为是超长截断到 80 字而不是拒绝，保留在 handler 里 slice
  name: z.string().trim().optional(),
  characterPrompt: z
    .string()
    .trim()
    .max(MAX_STICKER_CHARACTER_PROMPT_LENGTH, `角色描述过长（最多 ${MAX_STICKER_CHARACTER_PROMPT_LENGTH} 字）`)
    .optional(),
  referenceObjectKey: z.string().trim().min(1).optional(),
  presetKeys: z.array(z.string()).optional(),
});

export const stickerPackParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

/**
 * 模板选择清洗（领域规则，不进 schema）：没传/空数组 = 全部模板；
 * 非法 key 过滤掉、去重、截断到上限。清洗后为空由调用方报 400。
 */
export function sanitizePresetKeys(input: readonly string[] | undefined): string[] {
  if (!input || input.length === 0) {
    return STICKER_PRESETS.map((preset) => preset.key);
  }
  const keys = input.filter((key) => isStickerPresetKey(key));
  return [...new Set(keys)].slice(0, MAX_STICKER_PRESETS_PER_PACK);
}
