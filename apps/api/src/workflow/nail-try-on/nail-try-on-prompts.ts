export const NAIL_TRY_ON_CONSENT_VERSION = "nail-try-on-consent-v1";

/**
 * 试甲台提示词。mask 是「只改指甲、锁死手部」的硬保证；提示词只负责「指甲上画什么」，
 * 因此这里反复强调保持手不变，并要求美甲随每根指甲的形状与透视贴合。
 */
export function buildNailTryOnPrompt(args: {
  readonly hasDesignReference: boolean;
  readonly description?: string;
}): string {
  const description = args.description?.trim();
  return [
    "这是一次美甲试戴的局部重绘任务。参考图 1 是一只真实的手部照片，是必须原样保留的底图。",
    args.hasDesignReference
      ? "参考图 2 是美甲样式参考，仅用于提取指甲的颜色、图案、质感、装饰与风格，绝不改变手本身。"
      : "",
    "只在蒙版标出的指甲区域作画：蒙版透明处是需要重绘的指甲，其余不透明区域必须逐像素保持原样。",
    "严格保持手不变：手指形状、关节、皮肤纹理与肤色、手部姿态、光照方向、阴影、背景与构图全部不得改动。",
    "把美甲效果自然贴合到每一根被标注的指甲上：按每根指甲真实的形状、弧度、朝向与透视贴合，覆盖原有指甲或甲油，甲缘与皮肤过渡自然。",
    args.hasDesignReference
      ? "在忠实还原参考样式的前提下，让图案随每根指甲的大小与角度合理缩放、透视变形，而不是简单平铺同一张图。"
      : "若未提供样式参考，则按补充描述生成干净、真实、精致的美甲效果。",
    "输出必须是照片级真实、清晰的手部特写；不添加水印、文字、边框或任何无关元素。",
    description ? `美甲样式补充描述：${description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
