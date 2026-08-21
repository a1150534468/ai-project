import {
  HUMAN_IMAGE_MODEL,
  HUMAN_IMAGE_MODELS,
  humanImageOutputSize,
  type HumanImageAspectRatio,
  type HumanImageModel,
  type HumanImageResolution,
} from "../human-image-options.js";

export const PORTRAIT_CONSENT_VERSION = "portrait-consent-v1";
export const PORTRAIT_MODEL = HUMAN_IMAGE_MODEL;
export const PORTRAIT_MODELS = HUMAN_IMAGE_MODELS;
export type PortraitModelValue = HumanImageModel;

export const PORTRAIT_PRESET_IDS = [
  "business-elite",
  "linkedin",
  "id-photo",
  "guofeng",
  "sunny-casual",
  "poster",
  "wedding",
  "student-id",
  "founder-ip",
  "hk-retro",
  "oil-painting",
  "ink-gongbi",
  "magazine",
  "cyberpunk",
  "fairytale",
  "custom",
] as const;

export type PortraitPresetId = (typeof PORTRAIT_PRESET_IDS)[number];
export type PortraitPresetFinish = "photo" | "art";

export interface PortraitPresetDefinition {
  readonly id: PortraitPresetId;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly finish: PortraitPresetFinish;
  readonly allowText?: true;
}

export const PORTRAIT_PRESETS: readonly PortraitPresetDefinition[] = [
  { id: "business-elite", name: "商务精英", description: "西装+办公室", finish: "photo", prompt: "现代商务精英肖像，合身正装西装，现代办公室或落地窗城市景观背景，姿态自信专业，影棚级布光，浅景深" },
  { id: "linkedin", name: "LinkedIn 头像", description: "半身证件照风", finish: "photo", prompt: "LinkedIn 风格职业半身头像，浅色纯净背景，商务休闲着装，自然职业微笑，均匀柔和布光，肩部以上构图居中" },
  { id: "id-photo", name: "证件照", description: "简历/证件标准", finish: "photo", prompt: "标准证件照，纯色背景（白色或浅蓝），正面免冠，双肩水平，表情端正自然，布光均匀无阴影，符合证件照规范" },
  { id: "guofeng", name: "中国古风", description: "汉唐宋明", finish: "photo", prompt: "中国古风人像，汉唐宋明制式传统服饰，古典发髻与配饰，庭院、屏风或山水意境背景，东方古典美学，柔和国风色调" },
  { id: "sunny-casual", name: "阳光休闲", description: "咖啡馆/街拍", finish: "photo", prompt: "阳光休闲生活风人像，咖啡馆或城市街拍场景，自然光通透明亮，穿搭轻松时尚，状态松弛，抓拍质感" },
  { id: "poster", name: "海报形象", description: "中文大字+签名+品牌", finish: "photo", allowText: true, prompt: "个人品牌海报，人物为绝对主体，版面预留中文大字标题、个人签名与品牌标识位置，视觉层次分明，商业海报级布光构图" },
  { id: "wedding", name: "婚纱写真", description: "中西式", finish: "photo", prompt: "婚纱写真，西式白纱或中式秀禾/龙凤褂，浪漫唯美梦幻光效，场景可为教堂、花园或中式庭院，婚纱摄影级质感" },
  { id: "student-id", name: "学生证件", description: "校园/学位服", finish: "photo", prompt: "校园学生形象照，学位服或整洁学生装，校园背景（图书馆、教学楼、草坪），青春朝气，画面明亮通透" },
  { id: "founder-ip", name: "创业 IP", description: "杂志封面风", finish: "photo", allowText: true, prompt: "创业者个人 IP 形象，商业杂志封面风，自信有张力的姿态与眼神，高级感布光，简洁背景凸显人物气场，可预留刊名文字版面" },
  { id: "hk-retro", name: "复古港风", description: "90 年代港风/王家卫", finish: "photo", prompt: "90 年代复古港风人像，王家卫电影质感，胶片颗粒与暖调霓虹，复古发型妆造，老香港街景或昏黄室内灯光，情绪氛围浓郁" },
  { id: "oil-painting", name: "油画肖像", description: "文艺复兴/印象派", finish: "art", prompt: "古典油画肖像，文艺复兴或印象派笔触，油画布纹理，伦勃朗式用光，深色典雅背景，博物馆藏品级质感" },
  { id: "ink-gongbi", name: "国风工笔", description: "水墨/工笔画", finish: "art", prompt: "中国工笔画人物肖像，线条细腻设色淡雅，水墨晕染与留白意境，绢本质感，东方美学气韵" },
  { id: "magazine", name: "杂志大片", description: "Vogue/Bazaar 时尚", finish: "photo", prompt: "顶级时尚杂志大片，Vogue/Bazaar 风格，高级时装造型，张力构图与创意布光，表现力强，时尚编辑级色调" },
  { id: "cyberpunk", name: "赛博朋克", description: "霓虹未来感", finish: "photo", prompt: "赛博朋克人像，蓝紫粉霓虹光效，未来都市夜景，科技感服饰与灯光点缀，电影级氛围渲染" },
  { id: "fairytale", name: "童话漫画", description: "二次元/Disney 风", finish: "art", prompt: "童话漫画风格人物形象，迪士尼/皮克斯或二次元动画画风，保留人物可辨识特征，柔和线条明快色彩，梦幻童话背景" },
  { id: "custom", name: "自定义", description: "按你的描述创作", finish: "photo", prompt: "高品质单人肖像摄影" },
];

/** 旧版模板 id 的展示名，仅用于历史任务显示（poster 已被新「海报形象」复用）。 */
export const LEGACY_PORTRAIT_PRESET_NAMES: Readonly<Record<string, string>> = {
  business: "商务头像",
  social: "社交头像",
  lifestyle: "生活写真",
  traditional: "传统服饰",
};

export type PortraitAspectRatio = HumanImageAspectRatio;
export type PortraitResolution = HumanImageResolution;

export interface PortraitPromptOptions {
  readonly scene?: string;
  readonly outfit?: string;
  readonly composition?: string;
  readonly expression?: string;
  readonly hair?: string;
  readonly makeup?: string;
  readonly extraPrompt?: string;
}

export function portraitOutputSize(resolution: PortraitResolution, aspectRatio: PortraitAspectRatio): string {
  return humanImageOutputSize(resolution, aspectRatio);
}

export function buildPortraitPrompt(args: {
  readonly presetId: PortraitPresetId;
  readonly aspectRatio: PortraitAspectRatio;
  readonly options: PortraitPromptOptions;
}): string {
  const preset = PORTRAIT_PRESETS.find((item) => item.id === args.presetId) ?? PORTRAIT_PRESETS[0];
  const isArt = preset.finish === "art";
  const details = [
    args.options.scene ? `场景：${args.options.scene}` : "",
    args.options.outfit ? `服装：${args.options.outfit}` : "",
    args.options.composition ? `构图：${args.options.composition}` : "",
    args.options.expression ? `表情：${args.options.expression}` : "",
    args.options.hair ? `发型：${args.options.hair}` : "",
    args.options.makeup ? `妆容：${args.options.makeup}` : "",
    args.options.extraPrompt ? `补充要求：${args.options.extraPrompt}` : "",
  ].filter(Boolean);

  const identityLine = isArt
    ? "严格保持人物身份一致：保留真实的面部骨骼、五官比例、脸型、肤色、年龄特征、发际线与可见的独特特征；人物面部特征仍须与参考照片高度一致、可辨识，不进行换脸，不把人物变成其他人。"
    : "严格保持人物身份一致：保留真实的面部骨骼、五官比例、脸型、肤色、年龄特征、发际线与可见的独特特征；保持自然皮肤纹理，不进行换脸，不把人物变成其他人。";
  const contentRule = preset.allowText
    ? "画面中只出现这一位人物，不拼接多人，不添加水印、Logo 与证件样式元素，但允许按创作方向排版设计感中文文字。双眼、牙齿、双手和发丝结构自然，避免过度磨皮与塑料质感。"
    : "画面中只出现这一位人物，不拼接多人，不添加文字、水印、Logo、边框或身份证件样式元素。双眼、牙齿、双手和发丝结构自然，避免过度磨皮与塑料质感。";
  const closingLine = isArt
    ? "成片允许绘画/动画风格化处理，画面完成度高，人物面部特征仍须与参考照片高度一致、可辨识。"
    : "成片应为可直接使用的高品质摄影作品，人物面部清晰、曝光准确、色彩自然。";

  return [
    "根据所有参考照片创作一张同一个人的单人肖像。参考照片按上传顺序共同用于确认人物身份。",
    identityLine,
    contentRule,
    `创作方向：${preset.prompt}。`,
    `画面比例：${args.aspectRatio}。`,
    ...details,
    closingLine,
  ].join("\n");
}
