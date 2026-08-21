export const ECOM_MIN_SEGMENTS = 2;
export const ECOM_MAX_SEGMENTS = 8;

export const ECOM_PLATFORMS = [
  { id: "taobao", name: "淘宝", market: "domestic" },
  { id: "tmall", name: "天猫", market: "domestic" },
  { id: "jd", name: "京东", market: "domestic" },
  { id: "pdd", name: "拼多多", market: "domestic" },
  { id: "xianyu", name: "闲鱼", market: "domestic" },
  { id: "amazon", name: "Amazon", market: "foreign" },
  { id: "ebay", name: "eBay", market: "foreign" },
  { id: "etsy", name: "Etsy", market: "foreign" },
  { id: "shopee", name: "Shopee", market: "foreign" },
  { id: "lazada", name: "Lazada", market: "foreign" },
  { id: "shopify", name: "Shopify", market: "foreign" },
] as const;

export const ECOM_TEMPLATES = [
  {
    id: "general",
    name: "通用商品详情模板",
    tag: "全品类",
    style: "干净、真实、转化导向，浅色背景",
    master: "干净电商主视觉、商品居中、白底或浅渐变",
    segments: [
      "首屏/主视觉大图 + 一句话核心卖点",
      "中段/卖点三栏 + 细节展示",
      "尾段/参数信息表",
    ],
  },
  {
    id: "premium",
    name: "高端质感商品模板",
    tag: "高客单",
    style: "高级、克制、礼赠感，高级布光与质感材质",
    master: "高级感首屏、质感材质、深色或留白背景、柔和高光",
    segments: [
      "高级首屏大图",
      "材质工艺 + 局部特写",
      "参数规格 + 礼赠感收尾",
    ],
  },
  {
    id: "digital",
    name: "3C 数码卖点模板",
    tag: "科技感",
    style: "科技、参数、性能感，冷色光效",
    master: "科技主视觉、冷色光效、产品悬浮/爆炸图质感",
    segments: [
      "科技主视觉",
      "核心参数 + 功能拆解",
      "场景体验",
    ],
  },
  {
    id: "beauty",
    name: "美妆护肤成分模板",
    tag: "功效型",
    style: "清透、专业、成分可信，水润质感",
    master: "清透功效首屏、水润质感、明亮背景",
    segments: [
      "功效首屏",
      "成分说明 + 使用步骤",
      "肤感场景",
    ],
  },
  {
    id: "food",
    name: "食品保健信任模板",
    tag: "信任背书",
    style: "安心、原料、品质感，食欲色调",
    master: "食欲主视觉、原料环绕、暖色",
    segments: [
      "食欲主视觉",
      "原料来源 + 口感卖点",
      "检测背书 + 信任收尾",
    ],
  },
  {
    id: "gift",
    name: "礼品送礼场景模板",
    tag: "节日礼赠",
    style: "温暖、体面、场景化，暖光礼盒",
    master: "送礼主视觉、礼盒包装、暖光氛围",
    segments: [
      "送礼主视觉",
      "包装展示 + 适用场景",
      "心意表达收尾",
    ],
  },
  {
    id: "apparel",
    name: "服饰穿搭模板",
    tag: "服饰穿搭",
    style: "时尚、上身感、版型质感，自然光人像",
    master: "服饰主视觉、模特上身或质感平铺、自然光、时尚氛围",
    segments: [
      "穿搭主视觉 + 风格定位",
      "面料版型 + 细节做工",
      "多场景搭配展示",
    ],
  },
  {
    id: "home",
    name: "家居家装模板",
    tag: "家居场景",
    style: "温馨、空间感、软装氛围，居家自然光",
    master: "家居场景主视觉、软装搭配、空间氛围、自然光",
    segments: [
      "场景主视觉 + 空间氛围",
      "材质细节 + 功能展示",
      "多空间适配场景",
    ],
  },
] as const;

export type EcomPlatform = (typeof ECOM_PLATFORMS)[number];
export type EcomTemplate = (typeof ECOM_TEMPLATES)[number];
export type EcomPromptKind = "master" | "segment";
export type EcomSegmentIndex = 0 | 1 | 2;

const DOMESTIC_SEGMENT_ROLES = [
  {
    name: "首屏",
    task: "只生成详情页第 1 段首屏切片，用于长图顶部开场。",
    layout: "主视觉延展、标题层级、一句话核心卖点、少量信息卡，画面需要从母版过渡成详情页首屏。",
    avoid: "不要把母版整张照抄，不要生成完整三段长图，不要出现中段参数表或尾段收尾 CTA。",
  },
  {
    name: "中段",
    task: "只生成详情页第 2 段中段切片，用于承接首屏后的卖点拆解。",
    layout: "模块化卖点、功能参数、局部特写、图标或短标签说明，构图要明显区别于首屏。",
    avoid: "不要重复第 1 段的大标题、主视觉构图或整张海报，不要做尾段收尾。",
  },
  {
    name: "尾段",
    task: "只生成详情页第 3 段尾段切片，用于场景、信任背书或购买收尾。",
    layout: "使用场景、适用人群、保障信息、参数补充或结尾信任背书，保留纵向拼接的结束感。",
    avoid: "不要重复前两段的主视觉大图和卖点模块，不要重新生成首屏标题。",
  },
] as const;

const FOREIGN_SEGMENT_ROLES = [
  {
    name: "Hero section",
    task: "Create only segment 1, the top hero slice of a vertical product detail page.",
    layout: "Hero extension, headline hierarchy, one core benefit, and a few compact info cards.",
    avoid: "Do not copy the full master image, do not create a complete three-section long image, and do not include middle specs or final CTA blocks.",
  },
  {
    name: "Feature breakdown",
    task: "Create only segment 2, the middle slice for feature and specification breakdown.",
    layout: "Modular benefits, feature details, close-up material shots, icons, and concise labels; use a clearly different composition from segment 1.",
    avoid: "Do not repeat segment 1's main headline, hero layout, or full poster composition; do not create the final closing section.",
  },
  {
    name: "Scenario and closing",
    task: "Create only segment 3, the bottom slice for scenarios, trust proof, and closing information.",
    layout: "Usage scenes, audience fit, guarantees, supporting specs, or a closing trust block with a clear ending rhythm.",
    avoid: "Do not repeat the hero image or feature modules from earlier segments, and do not regenerate the top headline.",
  },
] as const;

export type BuildEcomPromptInput = {
  readonly platformId: string;
  readonly templateId: string;
  readonly kind: EcomPromptKind;
  readonly segmentIndex?: number;
  readonly segmentCount?: number;
  readonly name: string;
  readonly category: string;
  readonly sellingPoints: readonly string[];
  readonly extra: string;
};

type NormalizedProductInfo = {
  readonly name: string;
  readonly category: string;
  readonly sellingPoints: readonly string[];
  readonly extra: string;
};

function domesticLanguageRule(): string {
  return "中文海报文案规则：所有标题、副标题、卖点短句、参数标签都必须使用简体中文，符合中文电商海报表达，不要夹杂英文 slogan。";
}

function foreignLanguageRule(): string {
  return "English-only poster copy instruction: all headlines, benefit bullets, CTA copy, and parameter labels must be written in natural English only, with no Chinese text.";
}

export function getEcomPlatform(id: string): EcomPlatform | null {
  return ECOM_PLATFORMS.find((platform) => platform.id === id) ?? null;
}

export function getEcomTemplate(id: string): EcomTemplate | null {
  return ECOM_TEMPLATES.find((template) => template.id === id) ?? null;
}

function trimText(value: string): string {
  return value.trim();
}

function normalizeProductInfo(input: BuildEcomPromptInput): NormalizedProductInfo {
  return {
    name: trimText(input.name),
    category: trimText(input.category),
    sellingPoints: input.sellingPoints.map(trimText).filter((sellingPoint) => sellingPoint.length > 0),
    extra: trimText(input.extra),
  };
}

function hasProductInfo(productInfo: NormalizedProductInfo): boolean {
  return Boolean(
    productInfo.name ||
      productInfo.category ||
      productInfo.sellingPoints.length > 0 ||
      productInfo.extra,
  );
}

function segmentRoleIndex(segmentIndex: number, segmentCount: number): 0 | 1 | 2 {
  if (segmentIndex <= 0) return 0;
  if (segmentIndex >= segmentCount - 1) return 2;
  return 1;
}

function resolveSegmentFocus(template: EcomTemplate, segmentIndex: number | undefined, segmentCount: number): string {
  if (segmentIndex === undefined || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
    throw new Error(`segmentIndex must be an integer between 0 and ${segmentCount - 1} (got ${segmentIndex})`);
  }
  const roleIndex = segmentRoleIndex(segmentIndex, segmentCount);
  return template.segments[roleIndex];
}

function resolveDomesticSegmentLines(template: EcomTemplate, segmentIndex: number | undefined, segmentCount: number): readonly string[] {
  if (segmentIndex === undefined || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
    throw new Error(`segmentIndex must be an integer between 0 and ${segmentCount - 1} (got ${segmentIndex})`);
  }
  const roleIndex = segmentRoleIndex(segmentIndex, segmentCount);
  const role = DOMESTIC_SEGMENT_ROLES[roleIndex];
  const segmentName = `分段名称：第 ${segmentIndex + 1} 段（共 ${segmentCount} 段）「${role.name}」`;
  const focus = `分段焦点：${resolveSegmentFocus(template, segmentIndex, segmentCount)}`;
  const task = `单段任务：${role.task}`;
  const layout = `版式要求：${role.layout}`;
  const avoid = `重复规避：${role.avoid}`;
  const stitchConstraint = `拼接约束：输出必须是一张单段竖版切片，只占长图的一段（约 1/${segmentCount}）；继承母版配色、材质和商品一致性，但构图与内容必须和母版及相邻分段明显不同。`;
  const multiSegmentNote = roleIndex === 1 ? `多中段区别：本段为中段之一，构图/卖点角度必须与其它中段明显不同。` : null;
  return [segmentName, focus, task, layout, avoid, stitchConstraint, ...(multiSegmentNote ? [multiSegmentNote] : [])];
}

function resolveForeignSegmentLines(template: EcomTemplate, segmentIndex: number | undefined, segmentCount: number): readonly string[] {
  if (segmentIndex === undefined || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
    throw new Error(`segmentIndex must be an integer between 0 and ${segmentCount - 1} (got ${segmentIndex})`);
  }
  const roleIndex = segmentRoleIndex(segmentIndex, segmentCount);
  const role = FOREIGN_SEGMENT_ROLES[roleIndex];
  const segmentName = `Segment name: Segment ${segmentIndex + 1} of ${segmentCount} - ${role.name}`;
  const focus = `Segment focus: ${resolveSegmentFocus(template, segmentIndex, segmentCount)}`;
  const task = `Single-slice task: ${role.task}`;
  const layout = `Layout requirements: ${role.layout}`;
  const avoid = `Anti-duplication rule: ${role.avoid}`;
  const stitchConstraint = `Stitching constraint: output one vertical detail-page slice only, roughly one of ${segmentCount} slices of the final long image; inherit color, material, and product consistency from the master while keeping composition and content visibly different from the master and adjacent segments.`;
  const multiSegmentNote = roleIndex === 1 ? `Multiple middle sections: this is one of several middle slices; keep its composition and selling-point angle clearly different from the other middle slices.` : null;
  return [segmentName, focus, task, layout, avoid, stitchConstraint, ...(multiSegmentNote ? [multiSegmentNote] : [])];
}

export function buildEcomPrompt(input: BuildEcomPromptInput): string {
  const platform = getEcomPlatform(input.platformId);
  if (!platform) throw new Error(`Unknown e-commerce platform: ${input.platformId}`);
  const template = getEcomTemplate(input.templateId);
  if (!template) throw new Error(`Unknown e-commerce template: ${input.templateId}`);
  const productInfo = normalizeProductInfo(input);
  const segmentCount = input.segmentCount ?? 3;

  if (platform.market === "domestic") {
    const lines = [
      `平台：${platform.name}`,
      domesticLanguageRule(),
      `模板名称：${template.name}`,
      `模板标签：${template.tag}`,
      `模板风格：${template.style}`,
      ...(input.kind === "master" ? [`主视觉要求：${template.master}`] : resolveDomesticSegmentLines(template, input.segmentIndex, segmentCount)),
    ];
    if (hasProductInfo(productInfo)) {
      if (productInfo.name) lines.push(`商品名称：${productInfo.name}`);
      if (productInfo.category) lines.push(`商品类目：${productInfo.category}`);
      if (productInfo.sellingPoints.length > 0) lines.push(`卖点：${productInfo.sellingPoints.join("；")}`);
      if (productInfo.extra) lines.push(`补充信息：${productInfo.extra}`);
    } else {
      lines.push("商品信息未提供，避免编造未经提供的具体参数或功效");
    }
    return lines.join("\n");
  }

  const lines = [
    `Platform: ${platform.name}`,
    foreignLanguageRule(),
    `Template name: ${template.name}`,
    `Template tag: ${template.tag}`,
    `Template style: ${template.style}`,
    ...(input.kind === "master" ? [`Master visual: ${template.master}`] : resolveForeignSegmentLines(template, input.segmentIndex, segmentCount)),
  ];
  if (hasProductInfo(productInfo)) {
    if (productInfo.name) lines.push(`Product name: ${productInfo.name}`);
    if (productInfo.category) lines.push(`Category: ${productInfo.category}`);
    if (productInfo.sellingPoints.length > 0) lines.push(`Selling points: ${productInfo.sellingPoints.join("; ")}`);
    if (productInfo.extra) lines.push(`Extra context: ${productInfo.extra}`);
  } else {
    lines.push("Product information was not provided; avoid inventing unsupported specifications or claims.");
  }
  return lines.join("\n");
}
