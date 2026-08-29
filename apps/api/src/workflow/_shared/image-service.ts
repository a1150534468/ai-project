/**
 * image 上游服务的门面。原本这一个文件是 1090 行（常量 + 类型 + 上游交互 + 上游适配 +
 * 落盘 + 调用编排），P2.4 拆分后按依赖方向分成六个文件，这里只做转出：
 *
 * - `image-service-constants.ts` 模型名、上限、各家默认端点与像素边界（叶子）
 * - `image-service-types.ts`     配置/结果/入参形状（只依赖 constants）
 * - `image-service-upstream.ts`  错误类与分类、请求 ID、超时窗口、响应体读取
 * - `image-service-providers.ts` 端点解析、按模型选配置、各家尺寸参数整形
 * - `image-service-storage.ts`   对象键校验、抓图、量宽高、入库
 * - `image-service-calls.ts`     retryUntilSuccess 与四个生图/改图入口
 *
 * 对外导出面与拆分前逐字一致，仍是 43 个名字——约 40 个模块 import 本文件，一行都不用改。
 * `FetchLike` 拆分前是文件内私有别名（未导出），这里刻意不转出：门面不许放大契约。
 * 新代码要用更细的层，直接 import 对应文件，不要往这里补 re-export。
 */

export {
  DOUBAO_IMAGE_MODEL,
  GPT_IMAGE_MODEL,
  IMAGE_GENERATION_MODELS,
  IMAGE_MAX_REFERENCE_COUNT,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  QWEN_IMAGE_MODEL,
} from "./image-service-constants.js";
export type {
  CallImageEditArgs,
  CallImageGenerationArgs,
  GeneratedImage,
  ImageBinaryInput,
  ImageGenerationConfig,
  ImageGenerationErrorCategory,
  ImageGenerationErrorClassification,
  ImageGenerationModel,
  ImageGenerationResult,
  ImageGenerationUsage,
  RetryOptions,
  StoredImage,
  StoreWorkflowImageArgs,
} from "./image-service-types.js";
export {
  classifyImageGenerationError,
  extractGeneratedImage,
  ImageGenerationTimeoutError,
  ImageGenerationUpstreamError,
  imageTransportCode,
  imageUpstreamRequestIdFromHeaders,
  isRetryableImageGenerationError,
  loadImageAttemptTimeoutMs,
  readImagePayload,
  sanitizeImageUpstreamRequestId,
} from "./image-service-upstream.js";
export {
  imageStreamEnabled,
  loadGptImageEditEndpoint,
  loadImageEditEndpoint,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
} from "./image-service-providers.js";
export {
  isVerifiedWorkflowImageObjectKey,
  isVerifiedWorkflowImageObjectKeyForUser,
  storeWorkflowImage,
} from "./image-service-storage.js";
export {
  callImageEdit,
  callImageEditDetailed,
  callImageGeneration,
  callImageGenerationDetailed,
  retryUntilSuccess,
} from "./image-service-calls.js";
