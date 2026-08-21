// 资源计价 key（后台配价用；上线前须在 admin 资源计价页配真实单价并启用）
export const DUB_AVATAR_CLONE_KEY = "dub_avatar_clone"; // PER_CALL 按次·视频点
export const DUB_VIDEO_SEC_KEY = "dub_video_sec"; // PER_UNIT 按秒·视频点

// 本地任务状态
export const DUB_TASK_STATUS = { running: "running", completed: "completed", failed: "failed" } as const;
export type DubTaskStatus = (typeof DUB_TASK_STATUS)[keyof typeof DUB_TASK_STATUS];

export const DUB_TASK_KIND = { avatarClone: "avatar_clone", videoCreate: "video_create" } as const;
export type DubTaskKind = (typeof DUB_TASK_KIND)[keyof typeof DUB_TASK_KIND];

// 上传上限
export const DUB_AVATAR_VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100MB 场景视频
export const DUB_AUDIO_MAX_BYTES = 20 * 1024 * 1024; // 20MB 驱动音频

// 飞天并发信号量
export const DUB_SKY_INFLIGHT_KEY = "ai-assistant:dub:sky:inflight";
export const DUB_SKY_MAX_INFLIGHT = Number(process.env.SKYHUMAN_MAX_INFLIGHT ?? "3");
export const DUB_SKY_SLOT_TTL_SEC = 1800; // 单任务最长占位 30min，防崩溃泄漏

// reaper
export const DUB_REAPER_LOCK_KEY = "ai-assistant:dub:reaper:lock";
export const DUB_TASK_STALE_MS = 90_000; // running 超 90s 未终结即由 reaper 补查

// TTS 计费 key（后台配每字单价·算力点）
export const DUB_TTS_CHAR_KEY = "dub_tts_char"; // PER_UNIT 按输入字符·算力点

// MiMo TTS
export const DUB_TTS_TEXT_MAX_CHARS = 10000; // MiMo 单次上限 1 万字
export const DUB_TTS_CLONE_REF_MAX_BYTES = 10 * 1024 * 1024; // 复刻参考音频 ≤10MB
export const DUB_TTS_MODEL_BY_MODE = {
  preset: "mimo-v2.5-tts",
  design: "mimo-v2.5-tts-voicedesign",
  clone: "mimo-v2.5-tts-voiceclone",
} as const;
export type DubTtsMode = keyof typeof DUB_TTS_MODEL_BY_MODE;

// 分析（M3 视频直传拆解）
export const DUB_ANALYZE_VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 参考视频 ≤50MB（同既有 analyze-reference）
export const DUB_ANALYZE_MAX_TOKENS = 4000;

// 洗稿（M3 改写）
export const DUB_REWRITE_MAX_TOKENS = 3000;
export const DUB_REWRITE_PRICE_MULTIPLIER = 3; // 洗稿按模型原价 3 倍计费
export const DUB_REWRITE_BILLING_TYPE = "dub-rewrite"; // 账单显示用，隐藏模型名
export const DUB_REWRITE_TEXT_MAX_CHARS = 20000;

// BGM 与混流
export const DUB_BGM_MAX_BYTES = 20 * 1024 * 1024; // BGM 音频 ≤20MB
export const DUB_MIX_TIMEOUT_MS = 120_000;
export const DUB_BGM_VOLUME_MIN = 0;
export const DUB_BGM_VOLUME_MAX = 1;

// 项目阶段
export const DUB_STAGE = {
  draft: "draft", analyzed: "analyzed", scripted: "scripted", voiced: "voiced",
  generating: "generating", mixing: "mixing", done: "done", failed: "failed",
} as const;
export type DubStage = (typeof DUB_STAGE)[keyof typeof DUB_STAGE];

// —— 粘贴链接解析 ——
export const DUB_PARSE_VIDEO_KEY = "dub_parse_video"; // PER_CALL 按次·算力点
export const DUB_PARSE_VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 解析视频 ≤50MB（同 analyze 上限）
export const DUB_PARSE_COVER_MAX_BYTES = 10 * 1024 * 1024; // 封面 ≤10MB
export const DUB_PARSE_TIMEOUT_MS = 20_000; // 单次下载超时
export const DUB_PARSE_QUOTA_PER_HOUR = Number(process.env.DUB_PARSE_QUOTA_PER_HOUR ?? "20"); // 每用户每小时解析次数
