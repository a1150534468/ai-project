import type { HumanImageAspectRatio } from "../_shared/human-image-options.js";

export const TRY_ON_CONSENT_VERSION = "try-on-consent-v1";

export function buildTryOnPrompt(args: {
  readonly aspectRatio: HumanImageAspectRatio;
  readonly hasGarmentDetail: boolean;
  readonly hasModelReference: boolean;
  readonly description?: string;
}): string {
  const references = [
    "参考图 1 是必须准确还原的服装正面图。",
    args.hasGarmentDetail ? "参考图 2 是同一件服装的背面或细节图，只用于补充结构、材质和装饰信息。" : "",
    args.hasModelReference
      ? `参考图 ${args.hasGarmentDetail ? 3 : 2} 是模特人物图，只用于锁定人物身份、长相和自然体态。`
      : "",
  ].filter(Boolean);
  const modelRule = args.hasModelReference
    ? "严格保持模特人物身份一致：保留脸型、五官比例、肤色、年龄特征、发际线和可见独特特征；不要换脸、不要改变人物长相，也不要保留人物图里的原服装。"
    : "创建一位自然、真实、适合展示该服装的单人模特；人物长相、体态、场景和姿势优先遵循补充描述，未描述部分由你合理完成。";
  const description = args.description?.trim();

  return [
    "生成一张高品质、真实摄影风格的单人服装上身试穿图。",
    ...references,
    "服装还原是最高优先级：准确保留版型、领口、袖型、长度、面料质感、颜色、图案、Logo、纽扣、缝线和其他可见装饰，不擅自增删或改色。",
    modelRule,
    "让服装自然贴合人体并符合真实重力、褶皱和遮挡关系；完整清晰展示服装正面，避免手臂、头发、包袋或其他物体遮挡服装主体。",
    "画面中只出现一位人物，不添加文字、水印、边框或无关商品；面部、双手、肢体和服装结构自然，商业服装摄影级布光与清晰度。",
    `画面比例：${args.aspectRatio}。`,
    description ? `补充描述：${description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
