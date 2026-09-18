import type { HumanImageAspectRatio } from "../_shared/human-image-options.js";

export const TRY_ON_CONSENT_VERSION = "try-on-consent-v2";

export function buildTryOnPrompt(args: {
  readonly aspectRatio: HumanImageAspectRatio;
  readonly hasItemDetail: boolean;
  readonly hasSubjectReference: boolean;
  readonly description?: string;
}): string {
  const references = [
    "参考图 1 是必须准确还原并应用到画面中的目标素材。它可以是服装、鞋帽、首饰、眼镜、发型、妆容、纹身、配件、家具、装饰物或其他任何物品与视觉效果。",
    args.hasItemDetail ? "参考图 2 是同一目标素材的补充角度或细节图，只用于补充结构、材质、颜色和装饰信息。" : "",
    args.hasSubjectReference
      ? `参考图 ${args.hasItemDetail ? 3 : 2} 是承载试穿效果的主体图。主体可能是人物、动物、物体或空间，以图片实际内容为准。`
      : "",
  ].filter(Boolean);
  const subjectRule = args.hasSubjectReference
    ? "严格保持主体一致：若主体是人物，保留身份、脸型、五官比例、肤色、年龄和体态；若主体是动物、物体或空间，保留其外形、结构、材质、颜色、比例、视角和环境。只修改应用目标素材所必需的区域；原发型、穿搭、妆容和其他特征只在与目标效果冲突时改变，其余内容不要擅自修改。"
    : "根据目标素材及补充描述创建最合适的承载主体与场景。主体可以是人物、动物、物体或空间；不要默认生成服装模特，也不要把非服装素材强行解释为服装。";
  const description = args.description?.trim();

  return [
    "生成一张高品质的万物试穿效果图。",
    ...references,
    "先识别目标素材是什么，再判断它与主体之间合理的穿着、佩戴、附着、替换、摆放或装配关系；严格按素材真实用途和补充描述执行。",
    "目标素材还原是最高优先级：准确保留可见的外形、结构、比例、材质、颜色、图案、Logo、文字和独特细节，不擅自增删、改色或替换设计。",
    subjectRule,
    "若目标意图是换装、换发型、换妆容等替换效果，移除目标区域内与新效果冲突的原内容，不要将新旧元素错误叠加或混合。",
    "让目标素材与主体自然融合：尺度、位置、透视、光影、重力、形变、接触和遮挡关系必须合理；完整清晰展示关键效果，避免无关元素遮挡。",
    "默认输出真实、清晰、可直接比较效果的商业级画面；若参考图或补充描述指定了插画、动漫等风格，则准确延续该风格。不添加水印、边框、说明文字或无关物品。",
    `画面比例：${args.aspectRatio}。`,
    description ? `补充描述：${description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
