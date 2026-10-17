/** 表情包工坊：纯函数单测（prompt 构建 / 预设校验 / 状态常量）。 */
import { describe, expect, it } from "vitest";
import {
  sniffImageMime,
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

describe("sniffImageMime", () => {
  it("识别 PNG/JPEG/WebP 文件头", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10)]);
    const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(10)]);
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("未知头默认 png", () => {
    expect(sniffImageMime(Buffer.from("hello"))).toBe("image/png");
    expect(sniffImageMime(Buffer.alloc(0))).toBe("image/png");
  });
});
