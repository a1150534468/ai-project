export const PORTRAIT_CONSENT_VERSION = "portrait-consent-v1";
// Ark's API identifier for the Doubao Seedream 5.0 Lite product tier.
export const PORTRAIT_MODEL = "doubao-seedream-5-0-260128";

export const PORTRAIT_PRESETS = [
  { id: "business", name: "商务头像", description: "专业、克制的职业形象", prompt: "现代商务肖像，专业可信，干净的影棚布光，背景简洁" },
  { id: "social", name: "社交头像", description: "自然亲和的个人头像", prompt: "自然亲和的社交头像，真实生活感，柔和自然光" },
  { id: "lifestyle", name: "生活写真", description: "松弛自然的生活场景", prompt: "高品质生活写真，抓拍感，自然环境光，真实细腻" },
  { id: "traditional", name: "传统服饰", description: "传统审美与服饰表达", prompt: "传统服饰人物肖像，面料与纹样细节清晰，端庄含蓄" },
  { id: "poster", name: "个人海报", description: "具有主题感的视觉海报", prompt: "电影感个人海报，明确视觉主题，层次丰富，人物为绝对主体" },
  { id: "custom", name: "自定义", description: "按你的描述创作", prompt: "高品质单人肖像摄影" },
] as const;

export type PortraitPresetId = typeof PORTRAIT_PRESETS[number]["id"];
export type PortraitAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type PortraitResolution = "2K" | "4K";

export interface PortraitPromptOptions {
  readonly scene?: string;
  readonly outfit?: string;
  readonly composition?: string;
  readonly expression?: string;
  readonly hair?: string;
  readonly makeup?: string;
  readonly extraPrompt?: string;
}

const SIZE_BY_RESOLUTION: Readonly<Record<PortraitResolution, Readonly<Record<PortraitAspectRatio, string>>>> = {
  "2K": {
    "1:1": "2048x2048",
    "3:4": "1728x2304",
    "4:3": "2304x1728",
    "9:16": "1600x2848",
    "16:9": "2848x1600",
  },
  "4K": {
    "1:1": "4096x4096",
    "3:4": "3520x4704",
    "4:3": "4704x3520",
    "9:16": "3040x5504",
    "16:9": "5504x3040",
  },
};

export function portraitOutputSize(resolution: PortraitResolution, aspectRatio: PortraitAspectRatio): string {
  return SIZE_BY_RESOLUTION[resolution][aspectRatio];
}

export function buildPortraitPrompt(args: {
  readonly presetId: PortraitPresetId;
  readonly aspectRatio: PortraitAspectRatio;
  readonly options: PortraitPromptOptions;
}): string {
  const preset = PORTRAIT_PRESETS.find((item) => item.id === args.presetId) ?? PORTRAIT_PRESETS[0];
  const details = [
    args.options.scene ? `场景：${args.options.scene}` : "",
    args.options.outfit ? `服装：${args.options.outfit}` : "",
    args.options.composition ? `构图：${args.options.composition}` : "",
    args.options.expression ? `表情：${args.options.expression}` : "",
    args.options.hair ? `发型：${args.options.hair}` : "",
    args.options.makeup ? `妆容：${args.options.makeup}` : "",
    args.options.extraPrompt ? `补充要求：${args.options.extraPrompt}` : "",
  ].filter(Boolean);

  return [
    "根据所有参考照片创作一张同一个人的单人肖像。参考照片按上传顺序共同用于确认人物身份。",
    "严格保持人物身份一致：保留真实的面部骨骼、五官比例、脸型、肤色、年龄特征、发际线与可见的独特特征；保持自然皮肤纹理，不进行换脸，不把人物变成其他人。",
    "画面中只出现这一位人物，不拼接多人，不添加文字、水印、Logo、边框或身份证件样式元素。双眼、牙齿、双手和发丝结构自然，避免过度磨皮与塑料质感。",
    `创作方向：${preset.prompt}。`,
    `画面比例：${args.aspectRatio}。`,
    ...details,
    "成片应为可直接使用的高品质摄影作品，人物面部清晰、曝光准确、色彩自然。",
  ].join("\n");
}
