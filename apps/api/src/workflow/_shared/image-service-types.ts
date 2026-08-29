/**
 * image-service 拆分后的类型层：配置、上游返回、错误分类、入参/出参形状。
 *
 * 只依赖 constants（`ImageGenerationModel` 是从 `IMAGE_GENERATION_MODELS` 推出来的），
 * 编译产物为空，谁 import 都不会多出副作用。
 *
 * `FetchLike` 在拆分前是**未导出**的私有别名，这里为了跨文件复用才导出；
 * `image-service.ts` 门面刻意不转出它——原文件没导出过，门面不许放大契约。
 */

import { IMAGE_GENERATION_MODELS } from "./image-service-constants.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly protocol: "bailian" | "openai" | "volcengine";
}

export type ImageGenerationModel = typeof IMAGE_GENERATION_MODELS[number];

export type GeneratedImage = { readonly kind: "url"; readonly url: string } | { readonly kind: "b64"; readonly b64: string; readonly mime: string };

export interface ImageGenerationUsage {
  readonly inputTokens: number;
  readonly imageInputTokens: number;
  readonly textInputTokens: number;
  readonly outputTokens: number;
  readonly imageOutputTokens: number;
  readonly totalTokens: number;
}

export interface ImageGenerationResult {
  readonly image: GeneratedImage;
  /** Safe, bounded correlation ID from an allowlisted upstream response header. */
  readonly upstreamRequestId: string | null;
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly requestedSize: string;
  readonly actualSize: string;
  readonly requestedQuality: string;
  readonly actualQuality: string;
  readonly usage: ImageGenerationUsage | null;
}

export type ImageGenerationErrorCategory =
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "moderation"
  | "invalid_request"
  | "authentication"
  | "cancelled"
  | "network"
  | "unknown";

export interface ImageGenerationErrorClassification {
  readonly category: ImageGenerationErrorCategory;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string | null;
  readonly type: string | null;
  readonly upstreamRequestId: string | null;
  /** Bounded allowlisted network/TLS code; never contains an endpoint or message. */
  readonly transportCode: string | null;
}
export interface StoredImage {
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly mime: string;
  readonly objectKey: string | null;
  /** 实际交付像素；上游只给 url 且没配对象存储时拿不到，为 null。 */
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
  readonly shouldStop?: (error: unknown) => boolean;
}

export interface ImageBinaryInput {
  readonly b64: string;
  readonly mime?: string;
  readonly filename?: string;
}

export interface CallImageGenerationArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly size: string;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  /** Invoked before fetch to reserve an idempotent provider-dispatch slot. */
  readonly onRequestDispatching?: () => Promise<void> | void;
  /** Invoked immediately after fetch has been called for the provider POST. */
  readonly onRequestSent?: () => Promise<void> | void;
}

export interface CallImageEditArgs {
  readonly config: ImageGenerationConfig;
  readonly prompt: string;
  readonly referenceImages: readonly ImageBinaryInput[];
  readonly fetchFn: FetchLike;
  readonly size?: string;
  readonly mask?: ImageBinaryInput;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly quality?: "low" | "medium" | "high" | "auto";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  /** Invoked before fetch to reserve an idempotent provider-dispatch slot. */
  readonly onRequestDispatching?: () => Promise<void> | void;
  /** Invoked immediately after fetch has been called for the provider POST. */
  readonly onRequestSent?: () => Promise<void> | void;
}

export interface StoreWorkflowImageArgs {
  readonly image: GeneratedImage;
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly fetchFn: FetchLike;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly namespace?: string;
  readonly acl?: "public-read" | "private";
}
