import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function assertTempDiskSpace(targetPath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const minimum = positiveNumber(env.TEMP_MIN_FREE_BYTES, 2 * 1024 * 1024 * 1024);
  const info = await statfs(dirname(targetPath));
  const available = Number(info.bavail) * Number(info.bsize);
  if (available < minimum) {
    throw new Error(`临时磁盘空间不足：需要至少 ${minimum} 字节，当前可用 ${available} 字节`);
  }
}
