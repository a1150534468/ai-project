import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LoadEnvFile = (path?: string) => void;

function loadIfPresent(load: LoadEnvFile, path: string): void {
  try {
    load(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

export function autoloadEnvironmentFiles(
  env: NodeJS.ProcessEnv = process.env,
  load = (process as typeof process & { loadEnvFile?: LoadEnvFile }).loadEnvFile,
): void {
  if (env.VITEST || !load) return;
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  loadIfPresent(load, resolve(root, ".env.local"));
  loadIfPresent(load, resolve(root, ".env"));
}
