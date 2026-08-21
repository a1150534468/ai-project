import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callImageEditDetailed,
  classifyImageGenerationError,
  loadImageGenerationConfigForModel,
  GPT_IMAGE_MODEL,
  type ImageBinaryInput,
} from "./image-service.js";

const enabled = process.env.RUN_GPT_IMAGE_EDIT_POC === "1";
if (enabled) {
  const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  loadEnvFile?.(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../..", ".env"));
}

async function reference(color: string, label: string): Promise<ImageBinaryInput> {
  const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: color } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="110" r="72" fill="#fff"/><text x="128" y="210" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#111">${label}</text></svg>`) }])
    .png()
    .toBuffer();
  return { b64: png.toString("base64"), mime: "image/png", filename: `${label}.png` };
}

async function assertRealPng(result: Awaited<ReturnType<typeof callImageEditDetailed>>, expectedSize: string) {
  expect(result.image.kind).toBe("b64");
  if (result.image.kind !== "b64") throw new Error("POC requires base64 output");
  expect(result.image.mime).toBe("image/png");
  const metadata = await sharp(Buffer.from(result.image.b64, "base64")).metadata();
  expect(metadata.format).toBe("png");
  expect(`${metadata.width}x${metadata.height}`).toBe(result.actualSize);
  expect(result.requestedSize).toBe(expectedSize);
  expect(result.actualModel.length).toBeGreaterThan(0);
  expect(result.actualQuality.length).toBeGreaterThan(0);
  expect(result.usage).not.toBeNull();
  expect(result.usage?.totalTokens ?? 0).toBeGreaterThan(0);
}

describe.skipIf(!enabled)("GPT Image edits deployment POC", () => {
  it("edits one reference and returns base64 PNG plus real metadata", async () => {
    const config = loadImageGenerationConfigForModel(GPT_IMAGE_MODEL);
    const result = await callImageEditDetailed({
      config,
      prompt: "Turn this simple reference into one centered friendly desktop-pet mascot on a flat magenta background. No text.",
      referenceImages: [await reference("#2459c7", "one")],
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      fetchFn: fetch,
    });
    await assertRealPng(result, "1024x1024");
  }, 600_000);

  it("accepts multiple references and renders a separated landscape 4x2 pose board", async () => {
    const config = loadImageGenerationConfigForModel(GPT_IMAGE_MODEL);
    const result = await callImageEditDetailed({
      config,
      prompt: "Use both references to preserve one mascot identity. Generate exactly eight complete separated animation poses as a 4 columns by 2 rows board on a perfectly flat magenta background. Keep every pose inside its slot. No visible grid, labels, text, shadows or scenery.",
      referenceImages: [await reference("#2459c7", "blue"), await reference("#f2a23a", "orange")],
      size: "1536x1024",
      quality: "low",
      outputFormat: "png",
      fetchFn: fetch,
    });
    await assertRealPng(result, "1536x1024");
  }, 600_000);

  it("supports two concurrent edits in one worker process", async () => {
    const config = loadImageGenerationConfigForModel(GPT_IMAGE_MODEL);
    const sharedReference = await reference("#2459c7", "concurrent");
    const settled = await Promise.allSettled([1, 2].map((candidate) => callImageEditDetailed({
      config,
      prompt: `Create centered friendly desktop-pet candidate ${candidate} from this reference on a flat magenta background. No text.`,
      referenceImages: [sharedReference],
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      fetchFn: fetch,
    })));

    const failures = settled.flatMap((entry) => entry.status === "rejected"
      ? [{
          classification: classifyImageGenerationError(entry.reason),
          name: entry.reason instanceof Error ? entry.reason.name : typeof entry.reason,
          message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          causeCode: entry.reason instanceof Error
            && entry.reason.cause
            && typeof entry.reason.cause === "object"
            && "code" in entry.reason.cause
            ? String(entry.reason.cause.code)
            : null,
        }]
      : []);
    expect(failures, JSON.stringify(failures)).toEqual([]);
    for (const entry of settled) {
      if (entry.status === "fulfilled") await assertRealPng(entry.value, "1024x1024");
    }
  }, 600_000);

  it.each([
    {
      label: "429 rate limit",
      status: 429,
      code: "rate_limit_exceeded",
      message: "rate limit exceeded",
      category: "rate_limit",
      retryable: true,
    },
    {
      label: "5xx upstream failure",
      status: 503,
      code: "service_unavailable",
      message: "service unavailable",
      category: "upstream",
      retryable: true,
    },
    {
      label: "invalid request",
      status: 400,
      code: "invalid_image",
      message: "invalid image input",
      category: "invalid_request",
      retryable: false,
    },
    {
      label: "moderation rejection",
      status: 400,
      code: "moderation_blocked",
      message: "content policy moderation blocked",
      category: "moderation",
      retryable: false,
    },
  ])("classifies injected $label responses through the edits adapter", async ({ status, code, message, category, retryable }) => {
    const error = await callImageEditDetailed({
      config: {
        endpoint: "https://poc.invalid/v1/images/generations",
        apiKey: "poc-injected-key",
        model: GPT_IMAGE_MODEL,
        protocol: "openai",
      },
      prompt: "injected deployment classification check",
      referenceImages: [await reference("#2459c7", "classification")],
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      fetchFn: async () => new Response(JSON.stringify({
        error: { code, type: "image_generation_error", message },
      }), { status }),
    }).catch((caught: unknown) => caught);

    expect(classifyImageGenerationError(error)).toMatchObject({
      category,
      retryable,
      status,
      code,
      type: "image_generation_error",
    });
  });

  it("classifies an injected edits timeout as retryable", async () => {
    const error = await callImageEditDetailed({
      config: {
        endpoint: "https://poc.invalid/v1/images/generations",
        apiKey: "poc-injected-key",
        model: GPT_IMAGE_MODEL,
        protocol: "openai",
      },
      prompt: "injected deployment timeout check",
      referenceImages: [await reference("#2459c7", "timeout")],
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      env: { IMAGE_ATTEMPT_TIMEOUT_MS: "5" },
      fetchFn: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("injected abort"), { name: "AbortError" }));
        }, { once: true });
      }),
    }).catch((caught: unknown) => caught);

    expect(classifyImageGenerationError(error)).toMatchObject({
      category: "timeout",
      retryable: true,
      status: null,
    });
  });
});
