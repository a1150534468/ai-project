import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ImageBinaryInput } from "./image-service.js";
import { assertCodexPetVisualQaRoute, codexPetImageRetryDelayMs, codexPetVisualQaConsensusPasses, generateCodexPetIdentityGuide, generateCodexPetVisual, resolveCodexPetVisualQaModel, runCodexPetVisualQa, runLabeledDirectionSemantics, type PetVisualQaVerdict } from "./codex-pet-visual.js";

async function reference(index: number): Promise<ImageBinaryInput> {
  const buffer = await sharp({
    create: {
      width: 96 + index,
      height: 80 + index,
      channels: 4,
      background: { r: 30 * index, g: 80, b: 180, alpha: 1 },
    },
  }).png().toBuffer();
  return {
    b64: buffer.toString("base64"),
    mime: "image/png",
    filename: `reference-${index}.png`,
  };
}

describe("Codex pet visual generation", () => {
  it("requires a majority for every visual hard gate without demanding unanimity", () => {
    const passed: PetVisualQaVerdict = {
      pass: true,
      score: 95,
      mirrorSafe: true,
      identity: true,
      structure: true,
      semantics: true,
      continuity: true,
      warnings: [],
      failures: [],
      repairPrompt: "",
    };
    const semanticFailure = { ...passed, pass: false, semantics: false };
    const consensus = (verdicts: PetVisualQaVerdict[]) => ({
      pass: true,
      score: 90,
      mirrorSafe: true,
      warnings: [],
      failures: [],
      verdicts,
    });
    expect(codexPetVisualQaConsensusPasses(consensus([passed, passed, semanticFailure]))).toBe(true);
    expect(codexPetVisualQaConsensusPasses(consensus([passed, semanticFailure, semanticFailure]))).toBe(false);
  });

  it("defaults every pet visual reasoning task to GPT-5.6 and rejects non-GPT overrides", () => {
    expect(resolveCodexPetVisualQaModel({ CHAT_MULTIMODAL_MODEL: "qwen3.7-plus" })).toBe("gpt-5.6-sol");
    expect(resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
    expect(() => resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "qwen3.7-plus" }))
      .toThrow("must be gpt-5.6-sol");
    expect(() => resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "gpt-5.6-terra" }))
      .toThrow("must be gpt-5.6-sol");
  });

  it("requires an explicit GPT-5.6 model route instead of falling back to Bailian", () => {
    const base = {
      LLM_PROVIDER: "bailian",
      BAILIAN_WORKSPACE_ID: "ws-test",
      BAILIAN_API_KEY: "bailian-key",
      PET_VISUAL_QA_MODEL: "gpt-5.6-sol",
    } as NodeJS.ProcessEnv;
    expect(() => assertCodexPetVisualQaRoute(base)).toThrow("CHATGPT_API_KEY or GPT_IMAGE_API_KEY");
    expect(assertCodexPetVisualQaRoute({
      CHATGPT_API_KEY: "pixel-key",
      CHATGPT_MODELS: "gpt-5.6-sol",
      CHATGPT_BASE_URL: "https://pixel.test",
    })).toEqual({ model: "gpt-5.6-sol", baseURL: "https://pixel.test" });
    expect(() => assertCodexPetVisualQaRoute({
      ...base,
      CHATGPT_API_KEY: "pixel-key",
      CHATGPT_MODELS: "gpt-5.6-terra,qwen3.7-plus",
      CHATGPT_BASE_URL: "https://pixel.test",
    })).toThrow("must be present in CHATGPT_MODELS");
    expect(() => assertCodexPetVisualQaRoute({
      CHATGPT_API_KEY: "pixel-key",
      CHATGPT_MODELS: "gpt-5.6-sol",
      CHATGPT_BASE_URL: "file:///tmp/not-a-model-route",
    })).toThrow("must use HTTP(S)");
  });

  it("persists the actual GPT-5.6 response model and rejects a Qwen response", async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const verdict = { pass: true, score: 99, mirrorSafe: true, identity: true, structure: true, semantics: true, continuity: true, warnings: [], failures: [], repairPrompt: "" };
    const env = { LLM_BASE_URL: "https://test.invalid", LLM_API_KEY: "test-key", PET_VISUAL_QA_MODEL: "gpt-5.6-sol" };
    const client = (model: string) => ({ messages: { create: vi.fn(async () => ({
      model,
      content: [{ type: "text", text: JSON.stringify(verdict) }],
    })) } }) as never;

    await expect(runCodexPetVisualQa({ images: [{ buffer: image }], prompt: "qa", env, client: client("gpt-5.6-sol") }))
      .resolves.toMatchObject({
        pass: true,
        modelProvenance: { requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol", route: "injected_test_client" },
      });
    await expect(runCodexPetVisualQa({ images: [{ buffer: image }], prompt: "qa", env, client: client("qwen3.7-plus") }))
      .rejects.toThrow("visual model mismatch");
    await expect(runCodexPetVisualQa({ images: [{ buffer: image }], prompt: "qa", env, client: client("gpt-5.6-sol-qwen-fallback") }))
      .rejects.toThrow("visual model mismatch");
  });

  it("uses a bounded recovery window between transport retries", () => {
    expect(codexPetImageRetryDelayMs(1, {})).toBe(5_000);
    expect(codexPetImageRetryDelayMs(2, {})).toBe(15_000);
    expect(codexPetImageRetryDelayMs(3, {})).toBe(30_000);
    expect(codexPetImageRetryDelayMs(2, {
      CODEX_PET_IMAGE_RETRY_BASE_MS: "100",
      CODEX_PET_IMAGE_RETRY_MAX_MS: "250",
    })).toBe(250);
  });

  it("extracts a bounded anatomy guide from the approved canonical image", async () => {
    const approved = await sharp({
      create: { width: 96, height: 112, channels: 4, background: "#ff00ff" },
    }).png().toBuffer();
    const create = vi.fn(async (_body: unknown) => ({
      content: [{
        type: "text",
        text: "头：圆形；耳：无；眼：两只白眼；嘴：不可见；\n四肢：四只；尾巴：无；固定花纹：额头一点；可动特征：眼睛；歧义：额头点不是第三只眼。",
      }],
    }));
    const originalReferences = await Promise.all([1, 2, 3, 4].map(reference));
    const guide = await generateCodexPetIdentityGuide({
      reference: approved,
      mime: "image/png",
      originalReferences,
      characterBrief: "  蓝色机器人，棕色 U 形是两只相连的前爪。  ",
      client: { messages: { create } } as never,
      env: {
        LLM_BASE_URL: "https://llm.example.test",
        LLM_API_KEY: "test-key",
        PET_VISUAL_QA_MODEL: "gpt-5.6-sol",
      },
    });

    expect(guide).toBe("头：圆形；耳：无；眼：两只白眼；嘴：不可见； 四肢：四只；尾巴：无；固定花纹：额头一点；可动特征：眼睛；歧义：额头点不是第三只眼。");
    expect(create).toHaveBeenCalledOnce();
    const request = create.mock.calls[0]![0] as { model: string; messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(request.model).toBe("gpt-5.6-sol");
    const content = request.messages[0]!.content;
    expect(content).toHaveLength(5);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: approved.toString("base64") },
    });
    originalReferences.slice(0, 3).forEach((original, index) => {
      expect(content[index + 1]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: original.mime, data: original.b64 },
      });
    });
    expect(JSON.stringify(content)).not.toContain(originalReferences[3]!.b64);
    const prompt = String(content[4]!.text);
    expect(prompt).toContain("Image 1 is the approved canonical image and is the sole visual source of truth");
    expect(prompt).toContain("Images 2-4 are the original user references in upload order");
    expect(prompt).toContain("蓝色机器人，棕色 U 形是两只相连的前爪。");
    expect(prompt).toContain("头、耳、眼、嘴、四肢、尾巴、固定花纹、可动特征、歧义");
    expect(prompt).toContain("eyes, paws/feet and mouth from decorative markings");
    expect(prompt).toContain("not required to move in every animation or every frame");
    expect(prompt).toContain("must not override image 1's visible shape");
  });

  it("rejects an empty anatomy guide", async () => {
    const approved = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    await expect(generateCodexPetIdentityGuide({
      reference: approved,
      client: { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "   " }] })) } } as never,
      env: { LLM_BASE_URL: "https://llm.example.test", LLM_API_KEY: "test-key" },
    })).rejects.toThrow("empty guide");
  });

  it("injects the optional-movement rule into direction visual QA", async () => {
    const sheet = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const create = vi.fn(async (_body: unknown) => ({
      content: [{
        type: "text",
        text: JSON.stringify({ directions: [{
          direction: "000",
          verdict: "pass",
          expected: "up",
          observed: "up",
          horizontalEvidence: "centered",
          verticalEvidence: "eyes up",
          reason: "clear",
        }] }),
      }],
    }));

    await expect(runLabeledDirectionSemantics({
      sheet,
      expectedDirections: ["000"],
      identityGuide: "可动特征：眼睛与前爪；固定花纹：胸前棕色 U 形。",
      client: { messages: { create } } as never,
      env: { LLM_BASE_URL: "https://llm.example.test", LLM_API_KEY: "test-key" },
    })).resolves.toMatchObject([{ direction: "000", verdict: "pass" }]);

    const request = create.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const prompt = String(request.messages[0]!.content[1]!.text);
    expect(prompt).toContain("胸前棕色 U 形");
    expect(prompt).toContain("merely allowed to move when a state needs it");
    expect(prompt).toContain("do not require it to move in every animation or frame");
  });

  it.each([4, 5])(
    "compacts %i direction guidance images into at most three GPT edits parts",
    async (referenceCount) => {
      const output = await sharp({
        create: { width: 64, height: 64, channels: 4, background: "#ff00ff" },
      }).png().toBuffer();
      let uploadedParts: FormDataEntryValue[] = [];
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init!.body as FormData;
        uploadedParts = form.getAll("image[]");
        return new Response(JSON.stringify({
          model: "gpt-image-2-codex",
          size: "1536x1024",
          quality: "auto",
          data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            input_tokens_details: { image_tokens: 8, text_tokens: 2 },
            output_tokens_details: { image_tokens: 20 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      await generateCodexPetVisual({
        prompt: "Generate a registered 4x2 Codex pet direction board.",
        references: await Promise.all(Array.from({ length: referenceCount }, (_, index) => reference(index + 1))),
        size: "1536x1024",
        quality: "low",
        fetchFn: fetchFn as typeof fetch,
        env: {
          GPT_IMAGE_API_KEY: "test-key",
          GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
          GPT_IMAGE_EDIT_ENDPOINT: "https://images.example.test/v1/images/edits",
        },
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(uploadedParts).toHaveLength(3);
      const merged = uploadedParts.at(-1);
      expect(merged).toBeInstanceOf(Blob);
      const mergedBytes = Buffer.from(await (merged as Blob).arrayBuffer());
      const metadata = await sharp(mergedBytes).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(1_536);
      expect(metadata.height).toBe(referenceCount === 4 ? 768 : 1_536);
    },
  );

  it("rejects a non-GPT actual image model without retrying", async () => {
    const output = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "qwen-image-2.0-pro",
      data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(generateCodexPetVisual({
      prompt: "one pet",
      fetchFn: fetchFn as typeof fetch,
      env: {
        GPT_IMAGE_API_KEY: "test-key",
        GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
      },
    })).rejects.toThrow("image model mismatch");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([undefined, "gpt-image-2-qwen-fallback"])(
    "rejects an untrusted or missing actual image model (%s)",
    async (model) => {
      const output = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff00ff" } }).png().toBuffer();
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({
        ...(model ? { model } : {}),
        data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } }));

      await expect(generateCodexPetVisual({
        prompt: "one pet",
        fetchFn: fetchFn as typeof fetch,
        env: {
          GPT_IMAGE_API_KEY: "test-key",
          GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
        },
      })).rejects.toThrow("image model mismatch");
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );
});
