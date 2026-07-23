import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildBaseChoiceQaContext, buildVisualQaPrompt } from "../apps/api/src/workflow/codex-pet-prompts.js";
import { runCodexPetVisualQa } from "../apps/api/src/workflow/codex-pet-visual.js";

async function main(): Promise<void> {
  const outputDir = resolve(".cc-tmp/seedream-r2");
  const imagePath = resolve(outputDir, "base-candidate.png");
  const verdict = await runCodexPetVisualQa({
    images: [{ buffer: await readFile(imagePath), mime: "image/png" }],
    prompt: buildVisualQaPrompt("base-choice", buildBaseChoiceQaContext(1)),
    env: process.env,
  });
  const reportPath = resolve(outputDir, "visual-qa.json");
  await writeFile(reportPath, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, verdict }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
