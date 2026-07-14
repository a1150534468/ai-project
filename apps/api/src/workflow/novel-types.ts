export const NOVEL_SETUP_TARGET_KINDS = ["setupBible", "setupCharacters", "setupLocations", "setupPlot"] as const;
export type NovelSetupTargetKind = (typeof NOVEL_SETUP_TARGET_KINDS)[number];
export const NOVEL_TARGET_KINDS = [...NOVEL_SETUP_TARGET_KINDS, "chapter", "chapterRewrite"] as const;
export type NovelTargetKind = (typeof NOVEL_TARGET_KINDS)[number];

export const NOVEL_TASK_STATUS = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type NovelTaskStatus = (typeof NOVEL_TASK_STATUS)[keyof typeof NOVEL_TASK_STATUS];

export const NOVEL_RESOURCE_KEY = "novel_text_output";
export const NOVEL_COVER_RESOURCE_KEY = "novel_cover_generation";
