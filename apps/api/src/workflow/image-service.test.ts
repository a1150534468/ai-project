import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putObject } from "../storage/s3.js";
import {
  callImageEdit,
  callImageGeneration,
  extractGeneratedImage,
  loadImageEditEndpoint,
  loadImageGenerationConfig,
  retryUntilSuccess,
  storeWorkflowImage,
  type ImageGenerationConfig,
} from "./image-service.js";

const PNG_B64 = Buffer.from("png").toString("base64");

vi.mock("../storage/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/s3.js")>("../storage/s3.js");
  return {
    ...actual,
    makeS3: vi.fn(() => ({ client: {} as never, bucket: "yc-kb" })),
    putObject: vi.fn(async () => undefined),
  };
});

function createConfig(endpoint = "https://image.test/v1/images/generations"): ImageGenerationConfig {
  return {
    endpoint,
    apiKey: "image-key",
    model: "gpt-image-2",
  };
}

describe("image service", () => {
  beforeEach(() => {
    delete process.env.IMAGE_BASE_URL;
    delete process.env.IMAGE_GENERATION_ENDPOINT;
    delete process.env.IMAGE_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
  });

  it("loads image generation config from image or llm env values", () => {
    expect(loadImageGenerationConfig({
      IMAGE_BASE_URL: "https://image.test",
      IMAGE_API_KEY: "image-key",
    })).toEqual({
      endpoint: "https://image.test/v1/images/generations",
      apiKey: "image-key",
      model: "gpt-image-2",
    });

    expect(loadImageGenerationConfig({
      LLM_BASE_URL: "https://llm.test/v1",
      LLM_API_KEY: "llm-key",
      IMAGE_GENERATION_MODEL: "custom-image-model",
    })).toEqual({
      endpoint: "https://llm.test/v1/images/generations",
      apiKey: "llm-key",
      model: "custom-image-model",
    });

    expect(loadImageGenerationConfig({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/custom-endpoint",
      LLM_API_KEY: "llm-key",
    })).toEqual({
      endpoint: "https://relay.test/custom-endpoint",
      apiKey: "llm-key",
      model: "gpt-image-2",
    });
  });

  it("posts normalized json to the image generations endpoint", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime_type: "image/png" }] }), { status: 200 })
    );

    const image = await callImageGeneration({
      config: createConfig(),
      prompt: "ceramic plate",
      size: "2048x1152",
      fetchFn,
    });

    expect(image).toEqual({ kind: "b64", b64: PNG_B64, mime: "image/png" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://image.test/v1/images/generations",
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
      readonly prompt: string;
      readonly n: number;
      readonly response_format: string;
      readonly size: string;
      readonly resolution: string;
    };
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "ceramic plate",
      n: 1,
      response_format: "b64_json",
      size: "16:9",
      resolution: "2k",
    });
  });

  it("posts multipart edits with exactly two reference images and preserves raw output size", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime_type: "image/png" }] }), { status: 200 })
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

    expect(image).toEqual({ kind: "b64", b64: PNG_B64, mime: "image/png" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://image.test/v1/images/edits");
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer image-key" });
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("expected FormData body");
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("extend the poster");
    expect(form.get("n")).toBe("1");
    expect(form.get("size")).toBe("1024x1024");
    const images = form.getAll("image[]");
    expect(images).toHaveLength(2);
    expect(images[0]).toBeInstanceOf(File);
    expect(images[1]).toBeInstanceOf(File);
    if (!(images[0] instanceof File) || !(images[1] instanceof File)) {
      throw new Error("expected image[] files");
    }
    expect(await images[0].text()).toBe("segment-a");
    expect(await images[1].text()).toBe("segment-b");
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

    const firstForm = fetchFn.mock.calls[0]?.[1]?.body;
    const secondForm = fetchFn.mock.calls[1]?.[1]?.body;
    if (!(firstForm instanceof FormData) || !(secondForm instanceof FormData)) {
      throw new Error("expected FormData bodies");
    }
    expect(firstForm.get("size")).toBe("1024x1536");
    expect(secondForm.get("size")).toBe("auto");
  });

  it("derives the edit endpoint from config even when env is provided but empty", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, mime_type: "image/png" }] }), { status: 200 })
    );

    const image = await callImageEdit({
      config: createConfig("https://image.test/v1/images/generations"),
      prompt: "extend reliably",
      fetchFn,
      env: {},
      referenceImages: [{ b64: Buffer.from("segment").toString("base64"), mime: "image/png" }],
    });

    expect(image).toEqual({ kind: "b64", b64: PNG_B64, mime: "image/png" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://image.test/v1/images/edits",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("prefers explicit image edit endpoint and derives edits from recognizable generation endpoints", () => {
    expect(loadImageEditEndpoint({
      IMAGE_EDIT_ENDPOINT: "https://relay.test/v1/images/edits",
    })).toBe("https://relay.test/v1/images/edits");

    expect(loadImageEditEndpoint({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/v1/images/generations",
    })).toBe("https://relay.test/v1/images/edits");

    expect(loadImageEditEndpoint({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/v1/generations",
    })).toBe("https://relay.test/v1/edits");
  });

  it("throws a clear error when edit endpoint cannot be derived from an explicit generation endpoint", () => {
    expect(() => loadImageEditEndpoint({
      IMAGE_GENERATION_ENDPOINT: "https://relay.test/custom-endpoint",
    })).toThrow("IMAGE_EDIT_ENDPOINT required when IMAGE_GENERATION_ENDPOINT is not a recognized images/generations endpoint");
  });

  it("throws when the upstream image payload has no url or b64 output", () => {
    expect(() => extractGeneratedImage({ data: [{ revised_prompt: "missing image" }] })).toThrow(
      "image response has no url or b64_json",
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
        S3_BUCKET: "yc-kb",
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
