/**
 * image-service 拆分后的调用层：带重试的 `retryUntilSuccess`，以及生图/改图的
 * detailed 与简版四个入口。这一层只做编排——闸门许可、流式开关、超时窗口、错误转换
 * 全部委托给 upstream / providers，自己不解析 env 也不碰 S3。
 *
 * 依赖方向：constants / types / upstream / providers → 本文件。本族里没人 import 它，
 * 只有门面 `image-service.ts` 往外转。
 */

import { IMAGE_STREAM_PARTIAL_IMAGES } from "./image-stream.js";
import { withImageDispatchPermit } from "./image-dispatch-gate.js";
import { IMAGE_MAX_REFERENCE_COUNT } from "./image-service-constants.js";
import {
  detailedResult,
  fetchWithSignal,
  imageUpstreamRequestIdFromHeaders,
  loadImageAttemptTimeoutMs,
  readImagePayload,
  upstreamError,
  withImageAttemptDeadline,
} from "./image-service-upstream.js";
import {
  dataUrlForImageInput,
  gptImageSize,
  imageStreamEnabled,
  loadGptImageEditEndpoint,
  openAiEditImagePart,
  qwenImageParameters,
  seedreamSize,
  usesRequestBoundNativeQwenModel,
} from "./image-service-providers.js";
import type {
  CallImageEditArgs,
  CallImageGenerationArgs,
  GeneratedImage,
  ImageGenerationResult,
  RetryOptions,
} from "./image-service-types.js";

export async function retryUntilSuccess<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await fn();
    } catch (error) {
      if (options.shouldStop?.(error)) throw error;
      if (options.maxAttempts && attempts >= options.maxAttempts) throw error;
      await options.onRetry?.(error, attempts);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
}

export async function callImageGenerationDetailed(args: CallImageGenerationArgs): Promise<ImageGenerationResult> {
  const requestedQuality = args.quality ?? "auto";
  const requestedFormat = args.outputFormat ?? "png";
  const streamOpenAi = args.config.protocol === "openai" && imageStreamEnabled(args.env);
  const body = args.config.protocol === "openai"
    ? {
        model: args.config.model,
        prompt: args.prompt,
        n: 1,
        size: gptImageSize(args.size),
        quality: requestedQuality,
        output_format: requestedFormat,
        // 流式保活，绕开中继 60s 读超时；详见 image-stream.ts。
        ...(streamOpenAi ? { stream: true, partial_images: IMAGE_STREAM_PARTIAL_IMAGES } : {}),
      }
    : args.config.protocol === "volcengine"
      ? {
          model: args.config.model,
          prompt: args.prompt,
          n: 1,
          size: seedreamSize(args.size),
          response_format: "url",
          watermark: false,
        }
      : {
          model: args.config.model,
          input: {
            messages: [{ role: "user", content: [{ text: args.prompt }] }],
          },
          parameters: qwenImageParameters(args.size),
        };
  // 闸门在派发登记与 deadline 之外：四个域打同一个中继，谁也不许挤掉谁。
  return await withImageDispatchPermit({ endpoint: args.config.endpoint, signal: args.signal, env: args.env }, async () => {
    await args.onRequestDispatching?.();
    // deadline 包住「取响应 + 读 body」：流式出图的 body 阶段才是耗时主体。
    return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
      const response = await fetchWithSignal(args.fetchFn, args.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
        body: JSON.stringify(body),
      }, deadlineSignal, args.onRequestSent);
      if (!response.ok) throw await upstreamError(response);
      const payload = await readImagePayload(response);
      return await detailedResult(
        payload,
        { model: args.config.model, size: args.size, quality: requestedQuality },
        imageUpstreamRequestIdFromHeaders(response.headers),
        usesRequestBoundNativeQwenModel(args.config),
      );
    });
  });
}

export async function callImageGeneration(args: CallImageGenerationArgs): Promise<GeneratedImage> {
  return (await callImageGenerationDetailed(args)).image;
}

export async function callImageEditDetailed(args: CallImageEditArgs): Promise<ImageGenerationResult> {
  if (args.referenceImages.length < 1 || args.referenceImages.length > IMAGE_MAX_REFERENCE_COUNT) {
    throw new Error(`image editing requires 1 to ${IMAGE_MAX_REFERENCE_COUNT} reference images`);
  }
  if (args.config.protocol === "volcengine") {
    if (args.mask) throw new Error("Seedream image editing does not support a separate mask input");
    const requestedSize = seedreamSize(args.size?.trim() || "2048x2048");
    const images = args.referenceImages.map((image) => dataUrlForImageInput(image));
    const body = {
      model: args.config.model,
      prompt: args.prompt,
      image: images.length === 1 ? images[0] : images,
      size: requestedSize,
      response_format: "url",
      sequential_image_generation: "disabled",
      watermark: false,
    };
    const endpoint = args.endpoint ?? args.config.endpoint;
    return await withImageDispatchPermit({ endpoint, signal: args.signal, env: args.env }, async () => {
      await args.onRequestDispatching?.();
      return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
        const response = await fetchWithSignal(args.fetchFn, endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
          body: JSON.stringify(body),
        }, deadlineSignal, args.onRequestSent);
        if (!response.ok) throw await upstreamError(response);
        const payload = await response.json();
        return await detailedResult(
          payload,
          { model: args.config.model, size: requestedSize, quality: args.quality },
          imageUpstreamRequestIdFromHeaders(response.headers),
        );
      });
    });
  }
  if (args.config.protocol === "openai") {
    const env = args.env ?? process.env;
    const endpoint = args.endpoint ?? loadGptImageEditEndpoint(env, args.config.endpoint);
    const apiKey = env.GPT_IMAGE_EDIT_API_KEY?.trim() || args.config.apiKey;
    const requestedSize = gptImageSize(args.size) || "auto";
    const requestedQuality = args.quality ?? "auto";
    const outputFormat = args.outputFormat ?? "png";
    const form = new FormData();
    form.set("model", args.config.model);
    form.set("prompt", args.prompt);
    form.set("size", requestedSize);
    form.set("quality", requestedQuality);
    form.set("output_format", outputFormat);
    if (imageStreamEnabled(env)) {
      // 流式保活，绕开中继 60s 读超时；详见 image-stream.ts。
      form.set("stream", "true");
      form.set("partial_images", String(IMAGE_STREAM_PARTIAL_IMAGES));
    }
    const referenceParts = await Promise.all(args.referenceImages.map((image, index) => (
      openAiEditImagePart(image, `reference image ${index + 1}`, `reference-${index + 1}.png`)
    )));
    referenceParts.forEach(({ bytes, mime, filename }) => {
      form.append("image[]", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    });
    if (args.mask) {
      const { bytes, mime, filename } = await openAiEditImagePart(args.mask, "mask image", "mask.png");
      form.set("mask", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    }
    return await withImageDispatchPermit({ endpoint, signal: args.signal, env }, async () => {
      await args.onRequestDispatching?.();
      return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(env), args.signal, async (deadlineSignal) => {
        const response = await fetchWithSignal(args.fetchFn, endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
        }, deadlineSignal, args.onRequestSent);
        if (!response.ok) throw await upstreamError(response);
        const payload = await readImagePayload(response);
        return await detailedResult(
          payload,
          { model: args.config.model, size: requestedSize, quality: requestedQuality },
          imageUpstreamRequestIdFromHeaders(response.headers),
        );
      });
    });
  }
  if (args.mask) throw new Error("Qwen image editing does not support a separate mask input");
  const content = args.referenceImages.map((image) => ({ image: dataUrlForImageInput(image) }));
  const body = {
    model: args.config.model,
    input: {
      messages: [{ role: "user", content: [...content, { text: args.prompt }] }],
    },
    parameters: qwenImageParameters(args.size),
  };
  const configuredEditEndpoint = args.env?.IMAGE_EDIT_ENDPOINT?.trim();
  const endpoint = args.endpoint ?? configuredEditEndpoint ?? args.config.endpoint;
  return await withImageDispatchPermit({ endpoint, signal: args.signal, env: args.env }, async () => {
    await args.onRequestDispatching?.();
    return await withImageAttemptDeadline(loadImageAttemptTimeoutMs(args.env), args.signal, async (deadlineSignal) => {
      const response = await fetchWithSignal(args.fetchFn, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.config.apiKey}` },
        body: JSON.stringify(body),
      }, deadlineSignal, args.onRequestSent);
      if (!response.ok) throw await upstreamError(response);
      const payload = await response.json();
      return await detailedResult(
        payload,
        { model: args.config.model, size: args.size, quality: args.quality },
        imageUpstreamRequestIdFromHeaders(response.headers),
        usesRequestBoundNativeQwenModel(args.config),
      );
    });
  });
}

export async function callImageEdit(args: CallImageEditArgs): Promise<GeneratedImage> {
  return (await callImageEditDetailed(args)).image;
}
