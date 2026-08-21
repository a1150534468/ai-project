import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeNormalizedPoseBoard,
  createLayoutGuide,
  extractPoseBoard,
  petRowSpec,
} from "@ai-assistant/codex-pet-pipeline";
import { beforeAll, describe, expect, it } from "vitest";
import type { ImageBinaryInput } from "../_shared/image-service.js";
import {
  buildStandardRowPrompt,
  buildVisualQaPrompt,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";
import {
  generateCodexPetIdentityGuide,
  generateCodexPetVisual,
  runCodexPetVisualQaConsensus,
} from "./codex-pet-visual.js";

const enabled = process.env.RUN_CODEX_PET_ACTION_POC === "1";
if (enabled) {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const envFile = existsSync(resolve(root, ".env.local"))
    ? resolve(root, ".env.local")
    : resolve(root, ".env");
  (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(envFile);
}

const basePath = process.env.CODEX_PET_ACTION_POC_BASE?.trim() || "";
const originalReferencePaths = (process.env.CODEX_PET_ACTION_POC_REFERENCES?.trim() || "")
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean)
  .slice(0, 3);
const outputDir = process.env.CODEX_PET_ACTION_POC_OUTPUT_DIR?.trim() || "/tmp/codex-pet-action-poc";
const chromaKey = process.env.CODEX_PET_ACTION_POC_CHROMA_KEY?.trim() || "#ff00ff";
const characterBrief = process.env.CODEX_PET_ACTION_POC_BRIEF?.trim()
  || "月薪喵是以布偶猫与橘猫为原型的简约软萌原创手绘猫咪角色。";
const repairHint = process.env.CODEX_PET_ACTION_POC_REPAIR_HINT?.trim() || "";
const requestedStates = new Set(
  (process.env.CODEX_PET_ACTION_POC_STATES?.trim() || "failed,jumping")
    .split(",")
    .map((state) => state.trim())
    .filter(Boolean),
);
const selectedStates = (["failed", "jumping"] as const).filter((state) => requestedStates.has(state));

let canonical = Buffer.alloc(0);
let canonicalReference: ImageBinaryInput;
let identity: CodexPetVisualIdentity;

function providerSummary(provider: Awaited<ReturnType<typeof generateCodexPetVisual>>["provider"]) {
  return {
    upstreamRequestId: provider.upstreamRequestId,
    requestedModel: provider.requestedModel,
    actualModel: provider.actualModel,
    requestedSize: provider.requestedSize,
    actualSize: provider.actualSize,
    requestedQuality: provider.requestedQuality,
    actualQuality: provider.actualQuality,
    usage: provider.usage,
  };
}

describe.skipIf(!enabled)("Codex pet real standard-action POC", () => {
  beforeAll(async () => {
    if (!basePath) throw new Error("CODEX_PET_ACTION_POC_BASE is required");
    canonical = await readFile(basePath);
    if (canonical.byteLength === 0) throw new Error("CODEX_PET_ACTION_POC_BASE is empty");
    await mkdir(outputDir, { recursive: true });
    const originalReferences = await Promise.all(originalReferencePaths.map(async (path, index) => ({
      b64: (await readFile(path)).toString("base64"),
      mime: "image/png",
      filename: `original-reference-${index + 1}.png`,
    })));
    const guide = await generateCodexPetIdentityGuide({
      reference: canonical,
      mime: "image/png",
      originalReferences,
      characterBrief,
      env: process.env,
    });
    identity = {
      name: "本地真实 POC 桌宠",
      description: "验证共享 GPT Image edits 动作流水线",
      prompt: "",
      stylePreset: "pixel",
      styleNotes: "preserve the approved canonical pixel construction exactly",
      chromaKey,
      canonicalGuide: guide,
    };
    canonicalReference = {
      b64: canonical.toString("base64"),
      mime: "image/png",
      filename: "approved-canonical-base.png",
    };
    await writeFile(resolve(outputDir, "identity-guide.json"), JSON.stringify({ guide }, null, 2));
  }, 180_000);

  it.each(selectedStates)("generates and validates the real %s action", async (state) => {
    const spec = petRowSpec(state);
    const layout = await createLayoutGuide({
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      title: `${state} ${spec.frameCount}-pose board`,
    });
    const actionPrompt = buildStandardRowPrompt(identity, state);
    const generated = await generateCodexPetVisual({
      prompt: `${actionPrompt}${repairHint ? `\n\nRepair the complete pose group: ${repairHint}` : ""}`,
      references: [
        canonicalReference,
        { b64: layout.toString("base64"), mime: "image/png", filename: `${state}-layout.png` },
      ],
      size: "1536x1024",
      quality: "low",
      env: process.env,
    });
    await writeFile(resolve(outputDir, `${state}-raw.png`), generated.buffer);

    const extracted = await extractPoseBoard(generated.buffer, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      chromaKey,
      requireUnusedSlotsEmpty: true,
      allowVerticalTravel: state === "jumping",
      requireJumpingArc: state === "jumping",
      maxHeightRatio: 1.8,
    });
    const normalized = await composeNormalizedPoseBoard(extracted.frames, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      chromaKey,
    });
    await writeFile(resolve(outputDir, `${state}-normalized.png`), normalized);

    const qa = extracted.ok
      ? await runCodexPetVisualQaConsensus({
          images: [
            { buffer: canonical, mime: "image/png" },
            { buffer: normalized, mime: "image/png" },
          ],
          prompt: buildVisualQaPrompt(
            "row",
            `${state} 动作组：身份、${spec.frameCount} 帧结构、动作语义和连续性`,
            identity.canonicalGuide,
          ),
          repetitions: 1,
          env: process.env,
        })
      : null;
    await writeFile(resolve(outputDir, `${state}-result.json`), JSON.stringify({
      state,
      identityGuide: identity.canonicalGuide,
      provider: providerSummary(generated.provider),
      deterministic: {
        ok: extracted.ok,
        errors: extracted.errors,
        warnings: extracted.warnings,
        geometry: extracted.geometry,
        jumpingArc: extracted.jumpingArc,
        diagnostics: extracted.diagnostics,
        chroma: extracted.chroma,
        unusedSlotOpaquePixels: extracted.unusedSlotOpaquePixels,
      },
      visualQa: qa,
    }, null, 2));

    expect(extracted.ok, extracted.errors.join("; ")).toBe(true);
    expect(qa?.pass, qa?.failures.join("; ") || "visual QA did not pass").toBe(true);
  }, 600_000);
});
