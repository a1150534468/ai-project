import { describe, expect, it } from "vitest";
import {
  buildLocalBusinessPromoShotPlan,
  buildOptionsPayload,
  countLocalBusinessPromoSpeechChars,
  createDefaultSettings,
  createEmptyBrief,
  createEmptyMaterials,
  localBusinessPromoDurationWindow,
  localBusinessPromoNarrationBudget,
  musicPresetDescription,
  resolveLocalBusinessPromoFinalDuration,
  shotCountForDuration,
  splitScriptIntoShotLines,
  voiceSettingsDescription,
} from "./local-business-promo-core.js";

describe("local business promo core", () => {
  it("builds fixed shot counts for 25/40/60 seconds", () => {
    expect(shotCountForDuration(25)).toBe(3);
    expect(shotCountForDuration(40)).toBe(4);
    expect(shotCountForDuration(60)).toBe(6);
  });

  it("builds narration budgets from the selected duration and counts spoken characters conservatively", () => {
    const shortBudget = localBusinessPromoNarrationBudget(25);
    const longBudget = localBusinessPromoNarrationBudget(60);

    expect(shortBudget.shotCount).toBe(3);
    expect(shortBudget.maxDurationSec).toBe(28);
    expect(shortBudget.totalMaxChars).toBeGreaterThan(shortBudget.totalMinChars);
    expect(shortBudget.lines[0]).toMatchObject({ durationSec: 8, minChars: 17, maxChars: 24 });
    expect(longBudget.shotCount).toBe(6);
    expect(longBudget.totalMaxChars).toBe(168);
    expect(localBusinessPromoDurationWindow(40)).toMatchObject({ targetDurationSec: 40, maxDurationSec: 44, flexSec: 4 });
    expect(resolveLocalBusinessPromoFinalDuration(25, 27.6)).toBe(27.6);
    expect(resolveLocalBusinessPromoFinalDuration(25, 35)).toBe(28);
    expect(countLocalBusinessPromoSpeechChars("欢迎来到店里，今天带你看招牌 123。")).toBe(16);
  });

  it("splits script lines and pads when user text is shorter than the shot count", () => {
    expect(splitScriptIntoShotLines("第一句\n第二句", 4)).toEqual(["第一句", "第二句", "第二句", "第二句"]);
    expect(splitScriptIntoShotLines("第一句。第二句。第三句。第四句。", 3)).toEqual(["第一句。", "第二句。", "第三句。"]);
  });

  it("maps voice settings and music presets into prompt descriptions", () => {
    expect(voiceSettingsDescription({
      voiceMode: "preset",
      narrationVoice: "vv-female-natural",
      voiceDesignPrompt: "",
      voiceStylePrompt: "这段不应出现在预制音色描述里",
    })).toContain("旁白音色");
    expect(voiceSettingsDescription({
      voiceMode: "preset",
      narrationVoice: "vv-female-natural",
      voiceDesignPrompt: "",
      voiceStylePrompt: "这段不应出现在预制音色描述里",
    })).not.toContain("风格补充");
    expect(voiceSettingsDescription({
      voiceMode: "design",
      narrationVoice: "vv-male-warm",
      voiceDesignPrompt: "成熟可信的行业顾问男声",
      voiceStylePrompt: "尽量贴合商家介绍场景",
    })).toContain("文本定制音色");
    expect(voiceSettingsDescription({
      voiceMode: "clone",
      narrationVoice: "vv-male-warm",
      voiceDesignPrompt: "",
      voiceStylePrompt: "尽量贴合商家介绍场景",
    })).toContain("音频复刻音色");
    expect(voiceSettingsDescription({
      voiceMode: "clone",
      narrationVoice: "vv-male-warm",
      voiceDesignPrompt: "",
      voiceStylePrompt: "尽量贴合商家介绍场景",
    })).not.toContain("风格补充");
    expect(musicPresetDescription("premium-clean")).toContain("高级感");
    expect(musicPresetDescription("no-bgm")).toContain("弱化背景音乐");
  });

  it("defaults to preset mode and includes voice mode and template options", () => {
    const settings = createDefaultSettings();
    expect(settings.voiceMode).toBe("preset");
    expect(settings.voiceDesignPrompt).toBe("");
    const options = buildOptionsPayload();
    expect(options.voiceModes.map((item) => item.value)).toEqual(["preset", "design", "clone"]);
    expect(options.voiceTemplates.map((item) => item.value)).toEqual(["local-business-guide"]);
  });

  it("builds prompts that include script, subtitle style, and globally ranked material candidates", () => {
    const brief = {
      ...createEmptyBrief(),
      storeName: "山城轻食",
      industry: "轻食餐饮",
      cityArea: "重庆观音桥",
      targetCustomers: "附近白领和健身人群",
      mainOffer: "低卡轻食套餐",
      sellingPoints: "现做、口味清爽、出餐快",
    };
    const materials = {
      ...createEmptyMaterials(),
      opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8 }],
      process: [{ url: "https://example.test/process.png", mime: "image/png", name: "出餐过程", durationSec: 0 }],
      result: [{ url: "https://example.test/result.mp4", mime: "video/mp4", name: "成品", durationSec: 10 }],
    };
    const settings = {
      ...createDefaultSettings(),
      durationSec: 25,
      subtitleStyle: "douyin-outline",
      narrationVoice: "vv-female-natural",
      voiceStylePrompt: "语气自然可信",
      musicPreset: "city-lively",
    } as const;
    const shotPlan = buildLocalBusinessPromoShotPlan({
      brief,
      materials,
      settings,
      scriptDraft: "第一行\n第二行\n第三行",
    });

    expect(shotPlan).toHaveLength(3);
    expect(shotPlan[0]?.prompt).toContain("门店/品牌");
    expect(shotPlan[0]?.prompt).toContain("第一行");
    expect(shotPlan[0]?.prompt).toContain("抖音描边");
    expect(shotPlan[0]?.prompt).toContain("VV·女声·自然亲切");
    expect(shotPlan[0]?.materials[0]?.name).toBe("门头");
    expect(shotPlan[1]?.materials[0]?.name).toBe("出餐过程");
    expect(shotPlan[2]?.materials[0]?.name).toBe("成品");
    expect(shotPlan[1]?.materials.map((material) => material.name)).toContain("门头");
    expect(shotPlan[1]?.materials.map((material) => material.name)).toContain("成品");
  });
});
