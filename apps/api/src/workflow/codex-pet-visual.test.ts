import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { extractPoseBoard } from "@ai-assistant/codex-pet-pipeline";
import { DOUBAO_IMAGE_MODEL, type ImageBinaryInput } from "./image-service.js";
import { adaptCodexPetPromptForModel, assertCodexPetVisualQaRoute, codexPetImageDispatchCooldownMs, codexPetImageMaxAttempts, codexPetImageRetryDelayMs, codexPetVisualQaConsensusPasses, createSeedreamPoseBoardScaffold, generateCodexPetIdentityGuide, generateCodexPetVisual, normalizeSeedreamChromaMatte, resolveCodexPetVisualQaModel, runCodexPetVisualQa, runLabeledDirectionSemantics, selectSeedreamGaitScaffoldVariants, type PetVisualQaVerdict } from "./codex-pet-visual.js";
import { codexPetVisualQaRouteForModel } from "./codex-pet-model-contract.js";

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

async function nearEdgePoseBoard(columns: number, rows: number): Promise<Buffer> {
  const slotSize = 120;
  const pose = await sharp({
    create: {
      width: 80,
      height: 80,
      channels: 4,
      background: { r: 47, g: 179, b: 68, alpha: 1 },
    },
  }).png().toBuffer();
  const composites = Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      input: pose,
      left: column * slotSize + (index % 2 === 0 ? 4 : 36),
      top: row * slotSize + (index % 2 === 0 ? 36 : 4),
    };
  });
  return sharp({
    create: {
      width: columns * slotSize,
      height: rows * slotSize,
      channels: 4,
      background: { r: 229, g: 61, b: 50, alpha: 1 },
    },
  }).composite(composites).png().toBuffer();
}

describe("Codex pet visual generation", () => {
  it("paces distinct provider calls before dispatch when the relay needs a cooldown", async () => {
    expect(codexPetImageDispatchCooldownMs({})).toBe(0);
    expect(codexPetImageDispatchCooldownMs({ CODEX_PET_IMAGE_DISPATCH_COOLDOWN_MS: "45000" })).toBe(45_000);
    expect(codexPetImageDispatchCooldownMs({ CODEX_PET_IMAGE_DISPATCH_COOLDOWN_MS: "999999" })).toBe(300_000);

    const output = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#ff00ff" },
    }).png().toBuffer();
    const dispatchTimes: number[] = [];
    const fetchFn = vi.fn(async () => {
      dispatchTimes.push(Date.now());
      return new Response(JSON.stringify({
        model: "gpt-image-2-codex",
        data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const env = {
      GPT_IMAGE_API_KEY: "test-key",
      GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
      CODEX_PET_IMAGE_DISPATCH_COOLDOWN_MS: "40",
    };

    await Promise.all([
      generateCodexPetVisual({ prompt: "candidate one", fetchFn: fetchFn as typeof fetch, env }),
      generateCodexPetVisual({ prompt: "candidate two", fetchFn: fetchFn as typeof fetch, env }),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(30);
  });

  it("removes literal chroma tokens from Seedream prompts without changing GPT prompts", async () => {
    const source = "one pet as a 4 columns × 2 rows pose board on #FF00FF; never gradient the #ff00ff background";
    expect(adaptCodexPetPromptForModel(source, "gpt-image-2")).toBe(source);
    const adapted = adaptCodexPetPromptForModel(source, DOUBAO_IMAGE_MODEL);
    expect(adapted).not.toMatch(/#[0-9a-f]{6}/i);
    expect(adapted).toContain("flat solid hot-magenta chroma-key background");
    expect(adapted).toContain("Never draw or print the color name, hex code");

    const output = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 229, g: 61, b: 50, alpha: 1 } },
    }).composite([{
      input: await sharp({ create: { width: 16, height: 16, channels: 4, background: "#7bdc32" } }).png().toBuffer(),
      left: 24,
      top: 24,
    }]).png().toBuffer();
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { prompt?: string };
      expect(body.prompt).not.toMatch(/#[0-9a-f]{6}/i);
      expect(body.prompt).toContain("Never draw or print the color name, hex code");
      return new Response(JSON.stringify({
        model: DOUBAO_IMAGE_MODEL,
        data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const generated = await generateCodexPetVisual({
      prompt: source,
      model: DOUBAO_IMAGE_MODEL,
      fetchFn: fetchFn as typeof fetch,
      env: { ARK_API_KEY: "test-key", ARK_IMAGE_ENDPOINT: "https://ark.example.test/images/generations" },
    });
    expect(generated.provider.actualModel).toBe(DOUBAO_IMAGE_MODEL);
    expect(generated.mime).toBe("image/png");
    const normalized = await sharp(generated.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(normalized.info.width).toBe(64);
    expect(normalized.info.height).toBe(32);
    expect([...normalized.data.subarray(0, 3)]).toEqual([255, 0, 255]);
    let greenPixels = 0;
    for (let offset = 0; offset < normalized.data.length; offset += normalized.info.channels) {
      if (normalized.data[offset + 1]! > normalized.data[offset]! + 40) greenPixels += 1;
    }
    expect(greenPixels).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not mistake the final pet-cell size for a Seedream pose-board layout", async () => {
    const output = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 229, g: 61, b: 50, alpha: 1 } },
    }).composite([{
      input: await sharp({ create: { width: 16, height: 16, channels: 4, background: "#7bdc32" } }).png().toBuffer(),
      left: 24,
      top: 24,
    }]).png().toBuffer();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: DOUBAO_IMAGE_MODEL,
      data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const generated = await generateCodexPetVisual({
      prompt: "Keep the character readable inside a final 192×208 desktop-pet cell on #ff00ff.",
      model: DOUBAO_IMAGE_MODEL,
      fetchFn: fetchFn as typeof fetch,
      env: { ARK_API_KEY: "test-key", ARK_IMAGE_ENDPOINT: "https://ark.example.test/images/generations" },
    });
    const metadata = await sharp(generated.buffer).metadata();
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(64);
  });

  it.each([
    { columns: 3, rows: 2, prompt: "one pet as a 3 columns x 2 rows pose board on #ff00ff" },
    { columns: 4, rows: 2, prompt: "one pet as a 4 columns × 2 rows pose board on #ff00ff" },
    { columns: 2, rows: 2, prompt: "one pet as a 2x2 board on #ff00ff" },
  ])(
    "normalizes a Seedream $columns x $rows board slot-by-slot before extraction",
    async ({ columns, rows, prompt }) => {
      const normalized = await normalizeSeedreamChromaMatte(
        await nearEdgePoseBoard(columns, rows),
        prompt,
        DOUBAO_IMAGE_MODEL,
      );
      const metadata = await sharp(normalized.buffer).metadata();
      expect(metadata.width).toBe(columns * 120);
      expect(metadata.height).toBe(rows * 120);

      const extracted = await extractPoseBoard(normalized.buffer, {
        columns,
        rows,
        frameCount: columns * rows,
        chromaKey: "#ff00ff",
      });
      expect(extracted.ok, extracted.errors.join("\n")).toBe(true);
      expect(extracted.frames).toHaveLength(columns * rows);
      expect(extracted.diagnostics).toHaveLength(columns * rows);
      for (const diagnostic of extracted.diagnostics) {
        expect(diagnostic.sourceBounds).not.toBeNull();
        expect(diagnostic.opaquePixels).toBeGreaterThan(0);
        expect(diagnostic.componentCount).toBe(1);
        expect(diagnostic.edgePixels).toBe(0);
        expect(diagnostic.chromaCoverage).toBeGreaterThanOrEqual(0.08);
        expect(diagnostic.chromaCoverage).toBeLessThanOrEqual(0.985);
        expect(diagnostic.errors).not.toContain("empty-frame");
        expect(diagnostic.errors).not.toContain("source-touches-slot-edge");
      }
    },
  );

  it("builds a label-free Seedream scaffold with one connected canonical character per slot", async () => {
    const canonical = await sharp({
      create: { width: 256, height: 256, channels: 4, background: "#ff00ff" },
    }).composite([{
      input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="82" y="45" width="92" height="176" rx="30" fill="#35b978"/><circle cx="112" cy="100" r="10" fill="#fff"/><circle cx="144" cy="100" r="10" fill="#fff"/></svg>'),
    }]).png().toBuffer();
    const scaffold = await createSeedreamPoseBoardScaffold({
      canonical,
      chromaKey: "#ff00ff",
      columns: 3,
      rows: 2,
      frameCount: 6,
    });
    const metadata = await sharp(scaffold).metadata();
    expect(metadata).toMatchObject({ width: 1536, height: 1024 });
    const extracted = await extractPoseBoard(scaffold, {
      columns: 3,
      rows: 2,
      frameCount: 6,
      chromaKey: "#ff00ff",
    });
    expect(extracted.ok, extracted.errors.join("\n")).toBe(true);
    expect(extracted.frames).toHaveLength(6);
    expect(extracted.diagnostics.every((item) => item.componentCount === 1 && item.edgePixels === 0)).toBe(true);
  });

  it("alternates two supplied gait phases instead of cloning one canonical pose", async () => {
    const phase = async (rightLegX: number) => sharp({
      create: { width: 256, height: 256, channels: 4, background: "#ff00ff" },
    }).composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
        <rect x="78" y="42" width="100" height="128" rx="28" fill="#35b978"/>
        <rect x="94" y="160" width="28" height="62" rx="8" fill="#35b978"/>
        <rect x="${rightLegX}" y="160" width="28" height="62" rx="8" fill="#35b978"/>
        <rect x="150" y="82" width="18" height="18" fill="#ffffff"/>
      </svg>`),
    }]).png().toBuffer();
    const phaseA = await phase(134);
    const phaseB = await phase(116);
    const scaffold = await createSeedreamPoseBoardScaffold({
      canonical: phaseA,
      poseVariants: [phaseA, phaseB],
      variantSequence: [0, 1, 0, 1, 0, 1, 0, 1],
      chromaKey: "#ff00ff",
      columns: 4,
      rows: 2,
      frameCount: 8,
    });
    expect(await sharp(scaffold).metadata()).toMatchObject({ width: 1536, height: 768 });
    const extracted = await extractPoseBoard(scaffold, {
      columns: 4,
      rows: 2,
      frameCount: 8,
      chromaKey: "#ff00ff",
    });
    expect(extracted.ok, extracted.errors.join("\n")).toBe(true);
    expect(extracted.diagnostics.every((item) => item.componentCount === 1 && item.edgePixels === 0)).toBe(true);
    expect(extracted.frames[0]!.equals(extracted.frames[2]!)).toBe(true);
    expect(extracted.frames[1]!.equals(extracted.frames[3]!)).toBe(true);
    expect(extracted.frames[0]!.equals(extracted.frames[1]!)).toBe(false);
  });

  it("chooses the most distinct normalized paid phase while keeping frame zero as the anchor", async () => {
    const frames = await Promise.all([0, 1, 2, 3].map((offset) => sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="${4 + offset * 5}" y="8" width="${offset === 3 ? 13 : 10}" height="16" fill="#35b978"/></svg>`),
    }]).png().toBuffer()));
    const [anchor, variant] = await selectSeedreamGaitScaffoldVariants(frames);
    expect(anchor).toEqual(frames[0]);
    expect(variant).toEqual(frames[3]);
  });

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

  it("defaults to GPT-5.6, accepts marketplace choices, and rejects exhausted qwen3.7 models", () => {
    expect(resolveCodexPetVisualQaModel({ CHAT_MULTIMODAL_MODEL: "qwen3.7-plus" })).toBe("gpt-5.6-sol");
    expect(resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
    expect(() => resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "qwen3.7-plus" }))
      .toThrow("non-qwen3.7 marketplace model");
    expect(resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "gpt-5.6-terra" })).toBe("gpt-5.6-terra");
    expect(resolveCodexPetVisualQaModel({ PET_VISUAL_QA_MODEL: "qwen3.6-flash" })).toBe("qwen3.6-flash");
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

  it("routes Codex Auto Review to Pixel when CHATGPT_MODELS uses its default catalog", () => {
    expect(codexPetVisualQaRouteForModel("codex-auto-review", {})).toBe("chatgpt_model_route");
    expect(codexPetVisualQaRouteForModel("codex-auto-review", { CHATGPT_MODELS: "gpt-5.6-sol" })).toBe("chatgpt_model_route");
    expect(codexPetVisualQaRouteForModel("qwen3.6-flash", {})).toBe("bailian_model_route");
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

  it("retries transient visual QA connection errors with SDK retries disabled", async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const verdict = { pass: true, score: 99, mirrorSafe: true, identity: true, structure: true, semantics: true, continuity: true, warnings: [], failures: [], repairPrompt: "" };
    let attempts = 0;
    const create = vi.fn(async (_params?: unknown, _options?: unknown) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Connection error.");
        error.name = "APIConnectionError";
        throw error;
      }
      return { model: "gpt-5.6-sol", content: [{ type: "text", text: JSON.stringify(verdict) }] };
    });
    const client = { messages: { create } } as never;
    await expect(runCodexPetVisualQa({
      images: [{ buffer: image }],
      prompt: "qa",
      env: {
        CHATGPT_API_KEY: "test-key",
        CHATGPT_MODELS: "gpt-5.6-sol",
        CHATGPT_BASE_URL: "https://pixel.test",
        CODEX_PET_VISUAL_RETRY_BASE_MS: "0",
      },
      client,
    })).resolves.toMatchObject({ pass: true, modelProvenance: { actualModel: "gpt-5.6-sol" } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
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

  it("caps real-verification image transport attempts at one", async () => {
    expect(codexPetImageMaxAttempts({})).toBe(3);
    expect(codexPetImageMaxAttempts({ CODEX_PET_IMAGE_MAX_ATTEMPTS: "1" })).toBe(1);
    expect(codexPetImageMaxAttempts({ CODEX_PET_IMAGE_MAX_ATTEMPTS: "99" })).toBe(3);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: "temporary" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    await expect(generateCodexPetVisual({
      prompt: "one pet",
      model: DOUBAO_IMAGE_MODEL,
      fetchFn: fetchFn as typeof fetch,
      env: {
        ARK_API_KEY: "test-key",
        ARK_IMAGE_ENDPOINT: "https://ark.example.test/images/generations",
        CODEX_PET_IMAGE_MAX_ATTEMPTS: "1",
        CODEX_PET_IMAGE_RETRY_BASE_MS: "0",
      },
    })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledOnce();
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
    expect(prompt).toContain("Do not reinterpret 000 as a front portrait or 180 as a rear portrait");
  });

  it("rejects stale cardinal semantics even when the visual model reports pass", async () => {
    const sheet = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const create = vi.fn(async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ directions: [
          { direction: "000", verdict: "pass", expected: "front", observed: "front", reason: "old yaw convention" },
          { direction: "090", verdict: "pass", expected: "left", observed: "screen-left profile", reason: "horizontal swap" },
          { direction: "180", verdict: "pass", expected: "rear", observed: "rear", reason: "old yaw convention" },
          { direction: "270", verdict: "pass", expected: "right", observed: "screen-right profile", reason: "horizontal swap" },
        ] }),
      }],
    }));

    const verdicts = await runLabeledDirectionSemantics({
      sheet,
      expectedDirections: ["000", "090", "180", "270"],
      client: { messages: { create } } as never,
      env: { LLM_BASE_URL: "https://llm.example.test", LLM_API_KEY: "test-key" },
    });

    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(["fail", "fail", "fail", "fail"]);
    expect(verdicts.every((verdict) => verdict.reason.startsWith("Rejected stale cardinal semantics"))).toBe(true);
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

  it("honors a one-call approval budget without transport retries", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "temporarily unavailable", code: "service_unavailable" },
    }), { status: 503, headers: { "content-type": "application/json" } }));
    const onAttempt = vi.fn();
    const onRetry = vi.fn();

    await expect(generateCodexPetVisual({
      prompt: "one approved direction board",
      maxAttempts: 1,
      onAttempt,
      onRetry,
      fetchFn: fetchFn as typeof fetch,
      env: {
        GPT_IMAGE_API_KEY: "test-key",
        GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
      },
    })).rejects.toMatchObject({ status: 503, retryable: true });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(onAttempt).toHaveBeenCalledWith(1);
    expect(onRetry).not.toHaveBeenCalled();
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
