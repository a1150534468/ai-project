import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putObject } from "../storage/s3.js";
import {
  callImageEdit,
  callImageGeneration,
  extractGeneratedImage,
  loadImageEditEndpoint,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
  retryUntilSuccess,
  storeWorkflowImage,
  type ImageGenerationConfig,
} from "./image-service.js";

const PNG_B64 = Buffer.from("png").toString("base64");

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
    delete process.env.IMAGE_BASE_URL;
    delete process.env.IMAGE_GENERATION_ENDPOINT;
    delete process.env.IMAGE_API_KEY;
    delete process.env.GPT_IMAGE_API_KEY;
    delete process.env.GPT_IMAGE_GENERATION_ENDPOINT;
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
    });
  });

  it("does not send reference edits to an unconfigured GPT endpoint", async () => {
    await expect(callImageEdit({
      config: {
        endpoint: "https://pixel.test/v1/images/generations",
        apiKey: "gpt-image-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "edit",
      referenceImages: [{ b64: PNG_B64, mime: "image/png" }],
      fetchFn: vi.fn(),
    })).rejects.toThrow("reference editing is not configured");
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
