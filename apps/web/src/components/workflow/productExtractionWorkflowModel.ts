import type { ImageDraft } from "./imageWorkflowStudioModel";

export const PRODUCT_EXTRACTION_REQUEST_PREFIX = "product-extract-";

export const PRODUCT_EXTRACTION_INITIAL_DRAFT: ImageDraft = {
  prompt: "",
  model: "qwen-image-2.0-pro-2026-04-22",
  aspectRatio: "1:1",
  resolution: "1K",
  countInput: "1",
  referenceImages: [],
};

export function isProductExtractionRequestId(requestId: string): boolean {
  return requestId.startsWith(PRODUCT_EXTRACTION_REQUEST_PREFIX);
}

export function isGeneralImageRequestId(requestId: string): boolean {
  return !isProductExtractionRequestId(requestId);
}

export function buildProductExtractionPrompt(description: string): string {
  const productDescription = description.trim();
  return [
    `商品描述：${productDescription}`,
    "请编辑参考图，将参考图中的商品准确提取为电商白底平铺图。",
    "仅保留商品本体及商品原本包含的必要组成部分；严格保持商品的造型、比例、颜色、材质、纹理、包装、商标与可见文字，不得替换、重绘、增删或虚构商品细节。",
    "采用正上方俯拍的平铺陈列视角，商品完整、居中、摆放规整，保留均匀留白，不裁切、不遮挡、不堆叠。",
    "背景必须为均匀纯白色（#FFFFFF），光线柔和清晰，仅允许自然且很淡的接触阴影，不要环境、地面纹理、道具、装饰、人物、手、模特、边框、水印或额外文字。",
    "输出干净、真实、可直接用于商品目录的高质量单张图片。",
  ].join("\n");
}

export function productDescriptionFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.startsWith("商品描述：") ? firstLine.slice("商品描述：".length).trim() : prompt;
}
