import { describe, expect, it } from "vitest";
import {
  LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS,
  canGenerateLocalBusinessPromo,
  countProjectMaterials,
  createDefaultLocalBusinessPromoSettings,
  createEmptyLocalBusinessPromoAudioState,
  createEmptyLocalBusinessPromoBrief,
  createEmptyLocalBusinessPromoMaterials,
  formatLocalBusinessPromoProjectStatus,
  formatLocalBusinessPromoRunStatus,
  missingBriefLabels,
} from "./localBusinessPromoWorkflowModel";
import { WORKFLOW_MODULES } from "../../workflowState";

describe("localBusinessPromoWorkflowModel", () => {
  it("exposes fallback voice and music options for the workflow UI", () => {
    expect(LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS.narrationVoices.map((item) => item.value)).toContain("vv-female-natural");
    expect(LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS.voiceModes.map((item) => item.value)).toEqual(["preset", "design", "clone"]);
    expect(LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS.voiceTemplates.map((item) => item.value)).toEqual(["local-business-guide"]);
    expect(LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS.musicPresets.map((item) => item.value)).toContain("no-bgm");
  });

  it("tracks required brief fields and project material counts", () => {
    const brief = createEmptyLocalBusinessPromoBrief();
    expect(missingBriefLabels(brief)).toContain("门店/品牌名称");

    const materials = createEmptyLocalBusinessPromoMaterials();
    expect(countProjectMaterials(materials)).toBe(0);
    expect(countProjectMaterials({
      ...materials,
      opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8 }],
      result: [{ url: "https://example.test/result.png", mime: "image/png", name: "成品", durationSec: 0 }],
    })).toBe(2);
  });

  it("enables generate only when brief, materials, and script are ready", () => {
    const project = {
      id: "project-1",
      title: "禾木咖啡",
      brief: {
        ...createEmptyLocalBusinessPromoBrief(),
        storeName: "禾木咖啡",
        industry: "精品咖啡",
        cityArea: "上海静安",
        targetCustomers: "白领",
        mainOffer: "招牌拿铁",
        sellingPoints: "稳定出品",
      },
      materials: {
        ...createEmptyLocalBusinessPromoMaterials(),
        opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8 }],
      },
      settings: createDefaultLocalBusinessPromoSettings(),
      scriptDraft: "第一行\n第二行\n第三行",
      latestRunId: null,
      status: "draft" as const,
      createdAt: "2026-07-06T08:00:00.000Z",
      updatedAt: "2026-07-06T08:00:00.000Z",
    };

    expect(canGenerateLocalBusinessPromo(project)).toBe(true);
    expect(canGenerateLocalBusinessPromo({ ...project, scriptDraft: "" })).toBe(false);
  });

  it("formats user-facing project and run statuses", () => {
    expect(formatLocalBusinessPromoProjectStatus("draft")).toBe("草稿");
    expect(formatLocalBusinessPromoProjectStatus("generating")).toBe("生成中");
    expect(formatLocalBusinessPromoRunStatus("merging")).toBe("拼接中");
    expect(formatLocalBusinessPromoRunStatus("failed")).toBe("失败");
  });

  it("creates empty audio state and default preset-mode settings", () => {
    const settings = createDefaultLocalBusinessPromoSettings();
    expect(settings.narrationVoice).toBe("vv-female-natural");
    expect(settings.voiceMode).toBe("preset");
    expect(settings.voiceDesignPrompt).toBe("");
    expect(createEmptyLocalBusinessPromoAudioState()).toEqual({
      voiceCloneSample: null,
      activeNarration: null,
      activeBgm: null,
      narrationHistory: [],
      bgmHistory: [],
      tasks: [],
    });
  });

  it("registers the local business promo workflow module", () => {
    expect(WORKFLOW_MODULES.find((module) => module.id === "local-business-promo")?.title).toBe("本地商家宣传剪辑");
  });
});
