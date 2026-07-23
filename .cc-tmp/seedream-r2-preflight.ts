import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { buildBasePetPrompt } from "../apps/api/src/workflow/codex-pet-prompts.js";
import { DOUBAO_IMAGE_MODEL } from "../apps/api/src/workflow/image-service.js";
import { generateCodexPetVisual } from "../apps/api/src/workflow/codex-pet-visual.js";

async function main(): Promise<void> {
  const outputDir = resolve(".cc-tmp/seedream-r2");
  await mkdir(outputDir, { recursive: true });

  const prompt = buildBasePetPrompt({
    name: "像素种子助手",
    description: "一只小巧的绿色像素机器人桌宠，有方圆头部、短天线、深色面板、清晰双眼和小嘴，四肢与身体明确连接",
    prompt: "保持绿色像素机器人身份；造型简洁、轮廓连通、适合 192x208 桌宠单元格与后续九组动画",
    stylePreset: "pixel",
    styleNotes: "使用清晰硬边像素块，禁止柔光、渐变材质和细碎装饰",
    chromaKey: "#FF00FF",
  }, 1);

  const visual = await generateCodexPetVisual({
    prompt,
    model: DOUBAO_IMAGE_MODEL,
    size: "2048x2048",
    quality: "low",
    maxAttempts: 1,
  });

  const extension = visual.mime.includes("png") ? "png" : "jpg";
  const imagePath = resolve(outputDir, `base-candidate.${extension}`);
  await writeFile(imagePath, visual.buffer);

  const metadata = await sharp(visual.buffer).metadata();
  const report = {
    schemaVersion: "codex-pet-seedream-preflight-v1",
    createdAt: new Date().toISOString(),
    imagePath,
    mime: visual.mime,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    requestedModel: visual.provider.requestedModel,
    actualModel: visual.provider.actualModel,
    requestedSize: visual.provider.requestedSize,
    actualSize: visual.provider.actualSize,
    upstreamRequestId: visual.provider.upstreamRequestId,
    prompt,
  };
  const reportPath = resolve(outputDir, "preflight.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ imagePath, reportPath, ...report }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
