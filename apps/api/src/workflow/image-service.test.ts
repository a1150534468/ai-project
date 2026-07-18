import { Buffer } from "node:buffer";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putObject } from "../storage/s3.js";
import {
  callImageEditDetailed,
  callImageEdit,
  callImageGenerationDetailed,
  callImageGeneration,
  classifyImageGenerationError,
  extractGeneratedImage,
  imageUpstreamRequestIdFromHeaders,
  ImageGenerationTimeoutError,
  isVerifiedWorkflowImageObjectKeyForUser,
  loadImageEditEndpoint,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
  loadGptImageEditEndpoint,
  retryUntilSuccess,
  sanitizeImageUpstreamRequestId,
  storeWorkflowImage,
  type ImageGenerationConfig,
} from "./image-service.js";

const PNG_B64 = Buffer.from("png").toString("base64");

async function pngB64(width = 48, height = 32): Promise<string> {
  return (await sharp({ create: { width, height, channels: 4, background: "#ff00ff" } }).png().toBuffer()).toString("base64");
}

vi.mock("../storage/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/s3.js")>("../storage/s3.js");
  return {
    ...actual,
    makeS3: vi.fn(() => ({ client: {} as never, bucket: "ai-assistant-kb" })),
    putObject: vi.fn(async () => undefined),
  };
});

function createConfig(endpoint = "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"): ImageGenerationConfig {
  return {
    endpoint,
    apiKey: "image-key",
    model: "qwen-image-2.0-pro-2026-04-22",
    protocol: "bailian",
  };
}

describe("image service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IMAGE_BASE_URL;
    delete process.env.IMAGE_GENERATION_ENDPOINT;
    delete process.env.IMAGE_API_KEY;
    delete process.env.GPT_IMAGE_API_KEY;
    delete process.env.GPT_IMAGE_GENERATION_ENDPOINT;
    delete process.env.GPT_IMAGE_EDIT_API_KEY;
    delete process.env.GPT_IMAGE_EDIT_ENDPOINT;
    delete process.env.BAILIAN_WORKSPACE_ID;
    delete process.env.BAILIAN_REGION;
    delete process.env.BAILIAN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
  });

  it("requires the owner at the fixed workflow namespace segment", () => {
    expect(isVerifiedWorkflowImageObjectKeyForUser("workflow/images/u1/request/asset.png", "u1")).toBe(true);
    expect(isVerifiedWorkflowImageObjectKeyForUser("workflow/codex-pets/u1/project/run/asset.png", "u1")).toBe(true);
    expect(isVerifiedWorkflowImageObjectKeyForUser("workflow/images/u2/u1/asset.png", "u1")).toBe(false);
    expect(isVerifiedWorkflowImageObjectKeyForUser("workflow/custom/u1/request/asset.png", "u1")).toBe(false);
    expect(isVerifiedWorkflowImageObjectKeyForUser("workflow/images/u1/../asset.png", "u1")).toBe(false);
  });

  it("loads the native Bailian image endpoint and credentials", () => {
    expect(loadImageGenerationConfig({
      BAILIAN_WORKSPACE_ID: "ws-123",
      BAILIAN_REGION: "cn-beijing",
      BAILIAN_API_KEY: "bailian-key",
      IMAGE_API_KEY: "",
    })).toEqual({
      endpoint: "https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      apiKey: "bailian-key",
      model: "qwen-image-2.0-pro-2026-04-22",
      protocol: "bailian",
    });

    expect(loadImageGenerationConfig({
      IMAGE_BASE_URL: "https://image.test/api/v1",
      IMAGE_API_KEY: "image-key",
      IMAGE_GENERATION_MODEL: "custom-image-model",
    })).toEqual({
      endpoint: "https://image.test/api/v1/services/aigc/multimodal-generation/generation",
      apiKey: "image-key",
      model: "custom-image-model",
      protocol: "bailian",
    });

    expect(loadImageGenerationConfig({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/custom-endpoint",
      DASHSCOPE_API_KEY: "dashscope-key",
    })).toEqual({
      endpoint: "https://relay.test/custom-endpoint",
      apiKey: "dashscope-key",
      model: "qwen-image-2.0-pro-2026-04-22",
      protocol: "bailian",
    });
  });

  it("loads and calls the OpenAI-compatible GPT Image 2 generation endpoint", async () => {
    const config = loadImageGenerationConfigForModel("gpt-image-2", {
      GPT_IMAGE_API_KEY: "gpt-image-key",
      GPT_IMAGE_GENERATION_ENDPOINT: "https://pixel.test/v1/images/generations",
    });
    expect(config).toEqual({
      endpoint: "https://pixel.test/v1/images/generations",
      apiKey: "gpt-image-key",
      model: "gpt-image-2",
      protocol: "openai",
    });
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: PNG_B64 }],
    }), { status: 200 }));

    await expect(callImageGeneration({
      config,
      prompt: "minimal product photo",
      size: "2048x1152",
      fetchFn,
    })).resolves.toEqual({ kind: "b64", b64: PNG_B64, mime: "image/png" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://pixel.test/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer gpt-image-key" },
      }),
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "minimal product photo",
      n: 1,
      size: "2048x1152",
      quality: "auto",
      output_format: "png",
    });
  });

  it("returns detailed generation metadata while the legacy wrapper stays image-only", async () => {
    const outputB64 = await pngB64(80, 48);
    const responsePayload = {
      model: "gpt-image-2-codex",
      quality: "medium",
      data: [{ b64_json: outputB64 }],
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
    };
    const config: ImageGenerationConfig = {
      endpoint: "https://pixel.test/v1/images/generations",
      apiKey: "generation-key",
      model: "gpt-image-2",
      protocol: "openai",
    };
    const detailed = await callImageGenerationDetailed({
      config,
      prompt: "mascot portrait",
      size: "1024x1024",
      quality: "low",
      fetchFn: vi.fn(async () => new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "x-request-id": "req-generation-123" },
      })),
    });
    const legacy = await callImageGeneration({
      config,
      prompt: "mascot portrait",
      size: "1024x1024",
      quality: "low",
      fetchFn: vi.fn(async () => new Response(JSON.stringify(responsePayload), { status: 200 })),
    });

    expect(detailed).toMatchObject({
      upstreamRequestId: "req-generation-123",
      requestedModel: "gpt-image-2",
      actualModel: "gpt-image-2-codex",
      requestedSize: "1024x1024",
      actualSize: "80x48",
      requestedQuality: "low",
      actualQuality: "medium",
      usage: {
        inputTokens: 7,
        imageInputTokens: 0,
        textInputTokens: 0,
        outputTokens: 11,
        imageOutputTokens: 0,
        totalTokens: 18,
      },
    });
    expect(legacy).toEqual({ kind: "b64", b64: outputB64, mime: "image/png" });
  });

  it("posts GPT Image edits as multipart with multiple references, edit credentials, and detailed metadata", async () => {
    const outputB64 = await pngB64(64, 40);
    const firstReference = Buffer.from("reference-one").toString("base64");
    const secondReference = Buffer.from("reference-two").toString("base64");
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      model: "gpt-image-2-codex",
      size: "1536x1024",
      quality: "auto",
      data: [{ b64_json: outputB64, mime_type: "image/png" }],
      usage: {
        input_tokens: 101,
        input_tokens_details: { image_tokens: 90, text_tokens: 11 },
        output_tokens: 202,
        output_tokens_details: { image_tokens: 202 },
        total_tokens: 303,
      },
    }), { status: 200, headers: { "x-openai-request-id": "req-edit-456" } }));

    const result = await callImageEditDetailed({
      config: {
        endpoint: "https://pixel.test/v1/images/generations",
        apiKey: "generation-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "keep the mascot identity and create an eight-pose board",
      referenceImages: [
        { b64: firstReference, mime: "image/png", filename: "identity.png" },
        { b64: secondReference, mime: "image/webp", filename: "layout.webp" },
      ],
      size: "1536x1024",
      quality: "low",
      outputFormat: "png",
      env: {
        GPT_IMAGE_EDIT_ENDPOINT: "https://pixel.test/v1/images/edits",
        GPT_IMAGE_EDIT_API_KEY: "edit-key",
      },
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://pixel.test/v1/images/edits",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer edit-key" } }),
    );
    const form = fetchFn.mock.calls[0]?.[1]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("keep the mascot identity and create an eight-pose board");
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("quality")).toBe("low");
    expect(form.get("output_format")).toBe("png");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(result).toEqual({
      image: { kind: "b64", b64: outputB64, mime: "image/png" },
      upstreamRequestId: "req-edit-456",
      requestedModel: "gpt-image-2",
      actualModel: "gpt-image-2-codex",
      requestedSize: "1536x1024",
      actualSize: "64x40",
      requestedQuality: "low",
      actualQuality: "auto",
      usage: {
        inputTokens: 101,
        imageInputTokens: 90,
        textInputTokens: 11,
        outputTokens: 202,
        imageOutputTokens: 202,
        totalTokens: 303,
      },
    });
  });

  it("normalizes legacy raster references to PNG before GPT Image multipart edits", async () => {
    const outputB64 = await pngB64(32, 24);
    const tiff = await sharp({ create: { width: 40, height: 28, channels: 4, background: "#2266aa" } }).tiff().toBuffer();
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: outputB64, mime_type: "image/png" }],
    }), { status: 200 }));

    await callImageEditDetailed({
      config: { endpoint: "https://pixel.test/v1/images/generations", apiKey: "generation-key", model: "gpt-image-2", protocol: "openai" },
      prompt: "normalize the reference",
      referenceImages: [{ b64: tiff.toString("base64"), mime: "image/tiff", filename: "reference.tiff" }],
      size: "1024x1024",
      fetchFn,
      env: { GPT_IMAGE_EDIT_ENDPOINT: "https://pixel.test/v1/images/edits", GPT_IMAGE_EDIT_API_KEY: "edit-key" },
    });

    const form = fetchFn.mock.calls[0]?.[1]?.body as FormData;
    const part = form.get("image[]") as Blob & { readonly name?: string };
    expect(part.type).toBe("image/png");
    expect(part.name).toBe("reference.png");
    expect((await sharp(Buffer.from(await part.arrayBuffer())).metadata()).format).toBe("png");
  });

  it("derives the GPT edit endpoint and falls back to the generation API key", async () => {
    expect(loadGptImageEditEndpoint({}, "https://pixel.test/v1/images/generations?tenant=codex")).toBe(
      "https://pixel.test/v1/images/edits?tenant=codex",
    );
    expect(loadGptImageEditEndpoint({}, "https://pixel.test/v1/images/edits")).toBe(
      "https://pixel.test/v1/images/edits",
    );
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));

    await callImageEdit({
      config: {
        endpoint: "https://pixel.test/v1/images/generations",
        apiKey: "generation-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "edit",
      referenceImages: [{ b64: PNG_B64, mime: "image/png" }],
      fetchFn,
      env: {},
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://pixel.test/v1/images/edits",
      expect.objectContaining({ headers: { authorization: "Bearer generation-key" } }),
    );
  });

  it("posts native Bailian multimodal JSON and extracts its image URL", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://image.test/result.png" }] } }] },
      }), { status: 200 })
    );

    const image = await callImageGeneration({
      config: createConfig(),
      prompt: "ceramic plate",
      size: "2048x1152",
      fetchFn,
    });

    expect(image).toEqual({ kind: "url", url: "https://image.test/result.png" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer image-key",
        },
      }),
    );
    const [, init] = fetchFn.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      readonly model: string;
      readonly input: { readonly messages: readonly [{ readonly role: string; readonly content: readonly [{ readonly text: string }] }] };
      readonly parameters: { readonly n: number; readonly prompt_extend: boolean; readonly watermark: boolean; readonly size: string };
    };
    expect(body).toEqual({
      model: "qwen-image-2.0-pro-2026-04-22",
      input: { messages: [{ role: "user", content: [{ text: "ceramic plate" }] }] },
      parameters: { n: 1, prompt_extend: true, watermark: false, size: "2048*1152" },
    });
  });

  it("rejects output sizes beyond Qwen Image 2.0's total-pixel limit", async () => {
    const fetchFn = vi.fn();

    await expect(callImageGeneration({
      config: createConfig(),
      prompt: "oversized poster",
      size: "3840x2160",
      fetchFn,
    })).rejects.toThrow("between 512*512 and 2048*2048 total pixels");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts Qwen edits as multimodal JSON with base64 reference images", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://image.test/edited.png" }] } }] } }), { status: 200 })
    );
    const firstReference = Buffer.from("segment-a").toString("base64");
    const secondReference = Buffer.from("segment-b").toString("base64");

    const image = await callImageEdit({
      config: createConfig(),
      prompt: "extend the poster",
      size: "1024x1024",
      fetchFn,
      referenceImages: [
        { b64: firstReference, mime: "image/png" },
        { b64: secondReference, mime: "image/png" },
      ],
    });

    expect(image).toEqual({ kind: "url", url: "https://image.test/edited.png" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer image-key" });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: "qwen-image-2.0-pro-2026-04-22",
      input: { messages: [{ role: "user", content: [
        { image: `data:image/png;base64,${firstReference}` },
        { image: `data:image/png;base64,${secondReference}` },
        { text: "extend the poster" },
      ] }] },
      parameters: { n: 1, prompt_extend: true, watermark: false, size: "1024*1024" },
    });
  });

  it("preserves explicit width-height and auto sizes for image edits", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime_type: "image/png" }] }), { status: 200 })
    );
    const reference = { b64: Buffer.from("segment").toString("base64"), mime: "image/png" };

    await callImageEdit({
      config: createConfig(),
      prompt: "extend vertically",
      size: "1024x1536",
      fetchFn,
      referenceImages: [reference],
    });
    await callImageEdit({
      config: createConfig(),
      prompt: "extend automatically",
      size: "auto",
      fetchFn,
      referenceImages: [reference],
    });

    const firstBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(firstBody.parameters.size).toBe("1024*1536");
    expect(secondBody.parameters).not.toHaveProperty("size");
  });

  it("uses the same native multimodal endpoint for generation and editing", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime_type: "image/png" }] }), { status: 200 })
    );

    const image = await callImageEdit({
      config: createConfig("https://image.test/native-generation"),
      prompt: "extend reliably",
      fetchFn,
      env: {},
      referenceImages: [{ b64: Buffer.from("segment").toString("base64"), mime: "image/png" }],
    });

    expect(image).toEqual({ kind: "b64", b64: PNG_B64, mime: "image/png" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://image.test/native-generation",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("prefers an explicit edit endpoint and otherwise uses the native generation endpoint", () => {
    expect(loadImageEditEndpoint({
      IMAGE_EDIT_ENDPOINT: "https://relay.test/v1/images/edits",
    })).toBe("https://relay.test/v1/images/edits");

    expect(loadImageEditEndpoint({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/custom-endpoint",
    })).toBe("https://relay.test/custom-endpoint");
  });

  it("throws when the upstream image payload has no url or b64 output", () => {
    expect(() => extractGeneratedImage({ data: [{ revised_prompt: "missing image" }] })).toThrow(
      "image response has no generated image URL",
    );
  });

  it("extracts only bounded allowlisted upstream request IDs and falls back past unsafe headers", () => {
    expect(sanitizeImageUpstreamRequestId(" req-safe_123/abc ")).toBe("req-safe_123/abc");
    expect(sanitizeImageUpstreamRequestId("Bearer secret-value")).toBeNull();
    expect(sanitizeImageUpstreamRequestId("sk-test-secret-value")).toBeNull();
    expect(sanitizeImageUpstreamRequestId("x".repeat(201))).toBeNull();
    expect(imageUpstreamRequestIdFromHeaders(new Headers({
      "x-request-id": "unsafe request id",
      "x-openai-request-id": "req-fallback-789",
    }))).toBe("req-fallback-789");
    expect(imageUpstreamRequestIdFromHeaders(new Headers({
      "x-dashscope-request-id": "dashscope-request-456",
    }))).toBe("dashscope-request-456");
  });

  it.each([
    { status: 429, code: "rate_limit_exceeded", expected: { category: "rate_limit", retryable: true } },
    { status: 503, code: "service_unavailable", expected: { category: "upstream", retryable: true } },
    { status: 400, code: "moderation_blocked", expected: { category: "moderation", retryable: false } },
    { status: 400, code: "invalid_size", expected: { category: "invalid_request", retryable: false } },
  ])("classifies upstream image error $status/$code", async ({ status, code, expected }) => {
    const error = await callImageGeneration({
      config: {
        endpoint: "https://pixel.test/v1/images/generations",
        apiKey: "generation-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "mascot",
      size: "1024x1024",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({
        error: { code, type: "image_generation_error", message: code },
      }), { status, headers: { "x-request-id": `req-error-${status}` } })),
    }).catch((caught: unknown) => caught);

    expect(classifyImageGenerationError(error)).toMatchObject({
      ...expected,
      status,
      code,
      type: "image_generation_error",
      upstreamRequestId: `req-error-${status}`,
    });
  });

  it("classifies local timeout and cancellation separately", () => {
    expect(classifyImageGenerationError(new ImageGenerationTimeoutError(100))).toMatchObject({
      category: "timeout",
      retryable: true,
    });
    expect(classifyImageGenerationError(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toMatchObject({
      category: "cancelled",
      retryable: false,
    });
  });

  it("returns a data url when storing a b64 image without s3 config", async () => {
    const stored = await storeWorkflowImage({
      image: { kind: "b64", b64: PNG_B64, mime: "image/png" },
      userId: "u1",
      requestId: "req-1",
      requestIndex: 0,
      fetchFn: async () => new Response(null, { status: 500 }),
      env: {},
    });

    expect(stored).toEqual({
      originalUrl: `data:image/png;base64,${PNG_B64}`,
      thumbnailUrl: `data:image/png;base64,${PNG_B64}`,
      mime: "image/png",
      objectKey: null,
    });
  });

  it("keeps object storage but returns a data url for localhost s3 without public base", async () => {
    const stored = await storeWorkflowImage({
      image: { kind: "b64", b64: PNG_B64, mime: "image/png" },
      userId: "u1",
      requestId: "req-local",
      requestIndex: 0,
      fetchFn: async () => new Response(null, { status: 500 }),
      env: {
        S3_ENDPOINT: "http://localhost:9000",
        S3_BUCKET: "ai-assistant-kb",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY: "test-s3-access-key",
        S3_SECRET_KEY: "test-s3-secret-key",
        S3_FORCE_PATH_STYLE: "true",
      },
    });

    expect(stored.originalUrl).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(stored.thumbnailUrl).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(stored.objectKey).toMatch(/^workflow\/images\/u1\/req-local\/0-/);
    expect(putObject).toHaveBeenCalledOnce();
  });

  it("stores private workflow images in a custom namespace without a public URL or ACL", async () => {
    const stored = await storeWorkflowImage({
      image: { kind: "b64", b64: PNG_B64, mime: "image/webp" },
      userId: "u1",
      requestId: "pet-run-1",
      requestIndex: 3,
      namespace: "workflow/codex-pets",
      acl: "private",
      fetchFn: async () => new Response(null, { status: 500 }),
      env: {
        S3_ENDPOINT: "http://localhost:9000",
        S3_BUCKET: "ai-assistant-kb",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY: "test-s3-access-key",
        S3_SECRET_KEY: "test-s3-secret-key",
        S3_FORCE_PATH_STYLE: "true",
      },
    });

    expect(stored).toMatchObject({ originalUrl: "", thumbnailUrl: "", mime: "image/webp" });
    expect(stored.objectKey).toMatch(/^workflow\/codex-pets\/u1\/pet-run-1\/3-.*\.webp$/);
    expect(putObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^workflow\/codex-pets\/u1\/pet-run-1\/3-/),
      expect.any(Buffer),
      "image/webp",
      {},
    );
  });

  it("refuses private storage without S3 instead of leaking a data URL", async () => {
    await expect(storeWorkflowImage({
      image: { kind: "b64", b64: PNG_B64, mime: "image/png" },
      userId: "u1",
      requestId: "pet-run-1",
      requestIndex: 0,
      acl: "private",
      fetchFn: vi.fn(),
      env: {},
    })).rejects.toThrow("private workflow image storage requires S3 configuration");
  });

  it("retries transient failures until the operation succeeds", async () => {
    let attempts = 0;

    const result = await retryUntilSuccess(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`transient-${attempts}`);
      return "success";
    }, {
      retryDelayMs: 0,
      maxAttempts: 5,
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });
});
