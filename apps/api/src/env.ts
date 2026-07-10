import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LoadEnvFileFn = (path?: string) => void;

function tryLoadEnvFile(loadEnvFile: LoadEnvFileFn, path: string) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

function shouldAutoloadEnv() {
  return !process.env.VITEST;
}

function repoRootFromHere() {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
}

if (shouldAutoloadEnv()) {
  const loadEnvFile = (process as typeof process & { loadEnvFile?: LoadEnvFileFn }).loadEnvFile;
  if (loadEnvFile) {
    const repoRoot = repoRootFromHere();
    tryLoadEnvFile(loadEnvFile, resolve(repoRoot, ".env.local"));
    tryLoadEnvFile(loadEnvFile, resolve(repoRoot, ".env"));
  }
}
