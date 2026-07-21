import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";
import {
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  extractPoseBoard,
  petRowSpec,
} from "@ai-assistant/codex-pet-pipeline";
import { buildStandardRowPrompt, buildVisualQaPrompt, type CodexPetVisualIdentity } from "../apps/api/src/workflow/codex-pet-prompts.js";
import { loadCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";
import { runCodexPetVisualQaConsensus } from "../apps/api/src/workflow/codex-pet-visual.js";

const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
loadEnvFile?.(resolve(import.meta.dirname, "../.env"));

const runId = "cpr_12acdd88f1651d97391c2f7ee837683b";
const sourcePath = resolve(import.meta.dirname, "running-left/021d2e12.png");
const outputPath = resolve(import.meta.dirname, "running-left-real-qa.json");

async function main(): Promise<void> {
const prisma = getPrisma();
try {
  const run = await prisma.codexPetRun.findUniqueOrThrow({
    where: { id: runId },
    include: { project: true },
  });
  const identityJob = await prisma.codexPetJob.findUniqueOrThrow({
    where: { runId_key: { runId, key: "identity-guide" } },
  });
  const guide = String((identityJob.output as { guide?: string } | null)?.guide ?? "").trim();
  if (!guide || !run.selectedBaseArtifactId) throw new Error("run lacks canonical identity evidence");
  const canonicalArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.selectedBaseArtifactId } });
  const canonical = await loadCodexPetArtifact(canonicalArtifact);
  const identity: CodexPetVisualIdentity = {
    name: run.project.name,
    description: run.project.description,
    prompt: run.project.prompt,
    stylePreset: run.project.stylePreset,
    styleNotes: run.project.styleNotes,
    chromaKey: run.colorKey || "#ff00ff",
    canonicalGuide: guide,
  };
  const raw = await readFile(sourcePath);
  const spec = petRowSpec("running-left");
  const extracted = await extractPoseBoard(raw, {
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    chromaKey: identity.chromaKey,
    requireUnusedSlotsEmpty: true,
  });
  const normalized = await composeNormalizedPoseBoard(extracted.frames, {
    columns: spec.boardColumns,
    rows: spec.boardRows,
    chromaKey: identity.chromaKey,
  });
  const preview = extracted.ok
    ? await createAnimatedWebpPreview(extracted.frames, spec.durations)
    : null;
  const qa = extracted.ok && preview
    ? await runCodexPetVisualQaConsensus({
        images: [
          { buffer: canonical, mime: canonicalArtifact.mime },
          { buffer: normalized, mime: "image/png" },
          { buffer: preview.image, mime: preview.mime },
        ],
        prompt: buildVisualQaPrompt(
          "row",
          "running-left 动作组：身份、8 帧结构、动作语义和连续性。第二张图是完整静态 chronological eight-frame cycle，第三张是动画预览。允许自然的左向侧面或三分之二侧面视角遮挡远眼和部分正面面板；用可见眼、面板拓扑、头部模块、固定标记、比例和身体结构判断身份，不要把正常侧面遮挡误判为 identity drift。",
          identity.canonicalGuide,
        ),
        repetitions: 1,
        env: process.env,
      })
    : null;
  const result = {
    runId,
    sourcePath,
    provider: qa?.modelProvenance ?? null,
    deterministic: {
      ok: extracted.ok,
      errors: extracted.errors,
      warnings: extracted.warnings,
      geometry: extracted.geometry,
      diagnostics: extracted.diagnostics,
    },
    visualQa: qa,
    pass: Boolean(extracted.ok && qa?.pass),
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ pass: result.pass, deterministic: result.deterministic.ok, score: qa?.score, failures: qa?.failures, warnings: qa?.warnings, provider: result.provider }, null, 2));
} finally {
  await prisma.$disconnect();
}
}

void main();
