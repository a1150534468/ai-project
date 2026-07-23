import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";

const artifacts = [
  ["candidate-1.png", "workflow/codex-pets/cmrg7sx3w0002c3lsyza7tqci/cmrw8emyr0002c3mwewz8e87j/cpr_bae8f10ea94732e849f2d731a223df08/03cbc330-1f1e-4768-aa70-82b8be7e715f/主形象候选 1"],
  ["candidate-2.png", "workflow/codex-pets/cmrg7sx3w0002c3lsyza7tqci/cmrw8emyr0002c3mwewz8e87j/cpr_bae8f10ea94732e849f2d731a223df08/e2b0ee08-b5b2-4f98-8da7-835676b98c35/主形象候选 2"],
  ["qa.json", "workflow/codex-pets/cmrg7sx3w0002c3lsyza7tqci/cmrw8emyr0002c3mwewz8e87j/cpr_bae8f10ea94732e849f2d731a223df08/1fc15a26-2119-4445-a493-c73692e4111c/主形象自动选择失败报告"],
] as const;

async function main(): Promise<void> {
  const outputDir = resolve(".cc-tmp/seedream-r6");
  await mkdir(outputDir, { recursive: true });
  for (const [name, objectKey] of artifacts) {
    await writeFile(resolve(outputDir, name), await loadCodexPetArtifact(objectKey));
  }
  console.log(outputDir);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
