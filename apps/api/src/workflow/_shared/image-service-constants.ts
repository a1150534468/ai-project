/**
 * image-service 拆分后的常量层：模型名、参考图上限、各家上游的默认端点与像素/宽高比边界。
 *
 * 谁也不 import——这是这一族里唯一的叶子，types / upstream / providers / storage / calls
 * 都只能单向依赖它。往这里加 import 就等于给整族埋一个环。
 *
 * 模型串带修订日期后缀，是上游精确路由用的，改一个字符就是换模型，别"顺手规整"。
 */

export const QWEN_IMAGE_MODEL = "qwen-image-2.0-pro-2026-04-22";
export const GPT_IMAGE_MODEL = "gpt-image-2";
export const DOUBAO_IMAGE_MODEL = "doubao-seedream-4-5-251128";
export const IMAGE_GENERATION_MODELS = [QWEN_IMAGE_MODEL, GPT_IMAGE_MODEL, DOUBAO_IMAGE_MODEL] as const;
/** Qwen Image 编辑接口与现有生图工作台共同遵守的参考图上限。 */
export const IMAGE_MAX_REFERENCE_COUNT = 3;
export const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_REFERENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
]);
export const DEFAULT_IMAGE_MODEL = QWEN_IMAGE_MODEL;
export const DEFAULT_GPT_IMAGE_GENERATION_ENDPOINT = "https://api.ai-pixel.online/v1/images/generations";
export const DEFAULT_DOUBAO_IMAGE_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
export const DEFAULT_BAILIAN_REGION = "cn-beijing";
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
export const DEFAULT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
export const BAILIAN_IMAGE_GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
export const DEFAULT_QWEN_IMAGE_ENDPOINT = `https://dashscope.aliyuncs.com${BAILIAN_IMAGE_GENERATION_PATH}`;
export const QWEN_IMAGE_MIN_PIXELS = 512 * 512;
export const QWEN_IMAGE_MAX_PIXELS = 2048 * 2048;
export const GPT_IMAGE_MIN_PIXELS = 655_360;
export const GPT_IMAGE_MAX_PIXELS = 8_294_400;
export const GPT_IMAGE_MAX_EDGE = 3_840;
export const GPT_IMAGE_MAX_ASPECT_RATIO = 3;
export const SEEDREAM_MIN_PIXELS = 3_686_400;
export const SEEDREAM_MAX_PIXELS = 16_777_216;
export const SEEDREAM_MAX_ASPECT_RATIO = 3;
