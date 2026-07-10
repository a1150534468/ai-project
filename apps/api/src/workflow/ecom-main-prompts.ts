import { getEcomPlatform } from "./ecom-prompts.js";
import { getEcomMainStyleName, type EcomMainRatio, type EcomMainStyleId } from "./ecom-main.js";

export interface EcomMainProduct {
  readonly name: string;
  readonly category: string;
  readonly sellingPoints: readonly string[];
  readonly extra: string;
}

export interface BuildEcomMainPromptInput {
  readonly platformId: string;
  readonly language: string;
  readonly ratio: EcomMainRatio;
  readonly style: EcomMainStyleId;
  readonly customStyle: string;
  readonly product: EcomMainProduct;
  readonly index: number;
  readonly withText?: boolean;
}

export interface EcomMainPromptResult {
  readonly theme: string;
  readonly sceneRequirement: string;
  readonly copyRequirement: string;
  readonly prompt: string;
}

// 主图上叠加的卖点角标最多几条，超过则只突出重点，平衡画面密度。
const HERO_SELLING_POINT_CAP = 4;

const STYLE_DIRECTIVE: Readonly<Record<EcomMainStyleId, string>> = {
  amazon_clean: "clean white or light-gray studio background, product centered as the hero, true material and proportions, professional e-commerce look",
  real_life: "authentic real-life usage scene, natural lighting, lifestyle context with subtle human presence",
  premium_studio: "premium studio photography, controlled soft lighting, rich textured materials, high-end minimalist mood",
  infographic: "selling-point callout infographic, concise labels, icons and lines pointing at key product features",
  short_video: "short-video e-commerce vibe, punchy dynamic composition, bold single focal point, high energy",
  custom: "",
};

function platformName(platformId: string): string {
  return getEcomPlatform(platformId)?.name ?? platformId;
}

function styleDirective(style: EcomMainStyleId, customStyle: string): string {
  if (style === "custom") return customStyle.trim() || "clean commercial product photography";
  return STYLE_DIRECTIVE[style];
}

function normalizedSellingPoints(points: readonly string[]): readonly string[] {
  return points.map((item) => item.trim()).filter((item) => item.length > 0);
}

function pickSellingPoint(points: readonly string[], index: number): string {
  const normalized = normalizedSellingPoints(points);
  return normalized.length > 0 ? normalized[(index - 1 + normalized.length) % normalized.length] : "";
}

function isEnglish(language: string): boolean {
  return language.toLowerCase().startsWith("en");
}

function languageLabel(language: string): string {
  return isEnglish(language) ? "英文" : "中文";
}

function productLine(product: EcomMainProduct): string {
  const parts = [product.name, product.category, product.sellingPoints.join(", "), product.extra]
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parts.length > 0 ? parts.join("; ") : "a generic retail product";
}

function endingRule(withText: boolean): string {
  return withText
    ? "Photorealistic, high detail, accurate product, no watermark; any on-image text must be short, legible and correctly spelled."
    : "Photorealistic, high detail, accurate product, no watermark, no text and no lettering of any kind.";
}

function buildHero(input: BuildEcomMainPromptInput, platform: string, styleName: string): Omit<EcomMainPromptResult, "prompt"> & { readonly focus: string } {
  const lang = languageLabel(input.language);

  if (input.withText === false) {
    return {
      theme: `${platform} 主图：干净无字，突出产品本体`,
      sceneRequirement: `画幅为 ${input.ratio}。风格：${styleName}。产品占画面主体，保留真实材质与比例，背景干净，画面不出现任何文字。`,
      copyRequirement: "无字模式：主图不放任何文字，仅靠画面表现产品。",
      focus: "Hero main image: product centered, clean composition, absolutely no text or lettering.",
    };
  }

  const allPoints = normalizedSellingPoints(input.product.sellingPoints);
  const heroPoints = allPoints.slice(0, HERO_SELLING_POINT_CAP);
  const many = allPoints.length > HERO_SELLING_POINT_CAP;

  if (heroPoints.length === 0) {
    return {
      theme: `${platform} 主图：干净突出产品本体`,
      sceneRequirement: `画幅为 ${input.ratio}。风格：${styleName}。产品占画面主体，保留真实材质与比例，背景干净不喧宾夺主。`,
      copyRequirement: `主图可少字或无字，突出产品本体。文案语言使用${lang}。`,
      focus: "Hero main image: product centered, clean composition, minimal text.",
    };
  }

  const pointsCn = heroPoints.map((point) => `「${point}」`).join("、");
  const densityCn = many ? "；卖点较多时只突出最重要的几条，其余弱化，避免堆砌太满" : "";
  const densityEn = many ? "There are several selling points, so feature only the 3-4 most important prominently and keep the rest minimal to avoid a crowded layout. " : "";

  return {
    theme: `${platform} 主图：突出产品本体 + 融入核心卖点`,
    sceneRequirement: `画幅为 ${input.ratio}。风格：${styleName}。产品为画面主体，同时把卖点${pointsCn}做成简洁角标/短文案融入构图，密度均衡、留白舒适${densityCn}。`,
    copyRequirement: `将核心卖点作为画面上的简短角标/短文案融入（文案语言：${lang}）；卖点多时只突出最重要的 3~4 条，保持画面平衡不要太密。`,
    focus: `Hero main image: product is the clear focal point. Integrate the product's key selling points as concise, legible on-image text callouts/badges in ${isEnglish(input.language) ? "English" : "Chinese"}: ${heroPoints.join("; ")}. Arrange them with balanced spacing around the product. ${densityEn}Keep the composition clean, premium and readable.`,
  };
}

export function buildEcomMainImagePrompt(input: BuildEcomMainPromptInput): EcomMainPromptResult {
  const platform = platformName(input.platformId);
  const styleName = getEcomMainStyleName(input.style);
  const directive = styleDirective(input.style, input.customStyle);
  const isHero = input.index === 0;
  const withText = input.withText ?? true;

  if (isHero) {
    const hero = buildHero(input, platform, styleName);
    const prompt = [
      `E-commerce ${input.ratio} product image for platform ${platform}.`,
      `Product: ${productLine(input.product)}.`,
      `Style: ${directive}.`,
      hero.focus,
      endingRule(withText),
    ].join(" ");
    return { theme: hero.theme, sceneRequirement: hero.sceneRequirement, copyRequirement: hero.copyRequirement, prompt };
  }

  const sellingPoint = pickSellingPoint(input.product.sellingPoints, input.index);
  const lang = languageLabel(input.language);
  const focusPoint = sellingPoint || (withText ? "卖点/使用场景角度" : "使用场景/角度");
  const theme = `${platform} 辅图${input.index}：${focusPoint}`;
  const sceneRequirement = withText
    ? `画幅为 ${input.ratio}。风格：${styleName}。围绕${sellingPoint ? `卖点「${sellingPoint}」` : "一个差异化卖点/使用角度"}构图，与主图形成明显区别。`
    : `画幅为 ${input.ratio}。风格：${styleName}。围绕${sellingPoint ? `卖点「${sellingPoint}」` : "一个差异化使用场景/角度"}构图，画面不出现任何文字，与主图形成明显区别。`;
  const copyRequirement = withText
    ? `可放简短卖点标注${sellingPoint ? `（如「${sellingPoint}」）` : ""}。文案语言使用${lang}。`
    : "无字模式：本图不放文字，通过画面/场景表达卖点。";
  const focus = withText
    ? `Secondary image #${input.index} highlighting: ${sellingPoint || "a distinct selling point or usage angle"}. Render the selling point as a concise on-image callout. Use a clearly different composition from the hero.`
    : `Secondary image #${input.index} highlighting: ${sellingPoint || "a distinct selling point or usage angle"} through composition and scene only, with absolutely no text. Use a clearly different composition from the hero.`;

  const prompt = [
    `E-commerce ${input.ratio} product image for platform ${platform}.`,
    `Product: ${productLine(input.product)}.`,
    `Style: ${directive}.`,
    focus,
    endingRule(withText),
  ].join(" ");

  return { theme, sceneRequirement, copyRequirement, prompt };
}
