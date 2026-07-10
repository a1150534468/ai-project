import { existsSync } from "node:fs";
import { join } from "node:path";

// 连接器自带的 Python 运行时目录（打包进 extraResources/pyruntime/<平台>）。
// 打包后可从 process.resourcesPath 找到；找不到则返回 null → 回退系统 Python（开发环境）。
export function bundledPythonBinDir(): string | null {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath) return null;

  const sub =
    process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const base = join(resourcesPath, "pyruntime", sub);
  const exe =
    process.platform === "win32" ? join(base, "python.exe") : join(base, "bin", "python3");

  if (!existsSync(exe)) return null;
  // Windows 嵌入式包的 python.exe 在根目录；类 Unix 在 bin 子目录。
  return process.platform === "win32" ? base : join(base, "bin");
}
