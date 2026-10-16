/** 表情包工坊：纯函数单测（prompt 构建 / 预设校验 / 状态常量）。 */
import { describe, expect, it } from "vitest";
import {
  buildBaseCharacterPrompt,
  buildStickerPrompt,
  isStickerPresetKey,
  newStickerRequestId,
  STICKER_PACK_FINAL_STATUSES,
  STICKER_PACK_STATUS,
  STICKER_PRESETS,
  stickerPresetByKey,
  stickerStyleSuffix,
} from "./sticker-shared.js";

describe("STICKER_PRESETS", () => {
  it("有 16 个预设，key 唯一", () => {
    expect(STICKER_PRESETS).toHaveLength(16);
    const keys = STICKER_PRESETS.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(16);
  });

  it("每个预设都有中文 label 和英文 prompt", () => {
    for (const preset of STICKER_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("isStickerPresetKey / stickerPresetByKey", () => {
  it("合法 key 校验通过", () => {
    expect(isStickerPresetKey("happy")).toBe(true);
    expect(isStickerPresetKey("nope")).toBe(false);
    expect(stickerPresetByKey("cry")?.label).toBe("大哭");
    expect(stickerPresetByKey("nope")).toBeNull();
  });
});

describe("prompt 构建", () => {
  it("贴纸 prompt 包含角色描述、动作和风格", () => {
    const preset = stickerPresetByKey("happy")!;
    const prompt = buildStickerPrompt("一只橘猫", preset, "cute");
    expect(prompt).toContain("一只橘猫");
    expect(prompt).toContain(preset.prompt);
    expect(prompt).toContain("sticker");
    expect(prompt).toContain("no text");
  });

  it("主形象 prompt 包含角色描述和风格", () => {
    const prompt = buildBaseCharacterPrompt("一只橘猫", "cute");
    expect(prompt).toContain("一只橘猫");
    expect(prompt).toContain(stickerStyleSuffix("cute"));
  });

  it("风格后缀统一", () => {
    expect(stickerStyleSuffix("cute")).toContain("white outline");
  });
});

describe("状态常量", () => {
  it("终态集合正确", () => {
    expect(STICKER_PACK_FINAL_STATUSES.has(STICKER_PACK_STATUS.completed)).toBe(true);
    expect(STICKER_PACK_FINAL_STATUSES.has(STICKER_PACK_STATUS.failed)).toBe(true);
    expect(STICKER_PACK_FINAL_STATUSES.has(STICKER_PACK_STATUS.running)).toBe(false);
    expect(STICKER_PACK_FINAL_STATUSES.has(STICKER_PACK_STATUS.queued)).toBe(false);
  });

  it("requestId 唯一且带前缀", () => {
    const a = newStickerRequestId();
    const b = newStickerRequestId();
    expect(a).not.toBe(b);
    expect(a.startsWith("sticker_")).toBe(true);
  });
});
