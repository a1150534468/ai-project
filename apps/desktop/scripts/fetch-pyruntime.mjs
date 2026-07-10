// 下载并解压 Windows 嵌入式 Python 到 resources/pyruntime/win/，供连接器自带运行时打包。
// 构建机（Windows）在 electron-builder 打包前运行一次即可：
//   node apps/desktop/scripts/fetch-pyruntime.mjs
// 纯标准库脚本开箱即用，无需 pip。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PY_VERSION = "3.12.7";
const ZIP_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const winDir = join(here, "..", "resources", "pyruntime", "win");
const zipPath = join(here, "..", "resources", "pyruntime", `python-${PY_VERSION}-embed-amd64.zip`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`命令失败: ${cmd} ${args.join(" ")}`);
  }
}

async function main() {
  if (existsSync(join(winDir, "python.exe"))) {
    console.log(`[pyruntime] 已存在 ${winDir}\\python.exe，跳过下载。`);
    return;
  }
  mkdirSync(dirname(zipPath), { recursive: true });

  console.log(`[pyruntime] 下载 ${ZIP_URL}`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);
  console.log(`[pyruntime] 已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  console.log(`[pyruntime] 解压到 ${winDir}`);
  mkdirSync(winDir, { recursive: true });
  // Windows 用 PowerShell 解压；其它平台用 unzip。
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${winDir}' -Force`,
    ]);
  } else {
    run("unzip", ["-o", zipPath, "-d", winDir]);
  }

  // 复制 python3.exe（部分命令用 python3；两者都会回退到 python312._pth，无需额外 ._pth）。
  const pythonExe = join(winDir, "python.exe");
  const python3Exe = join(winDir, "python3.exe");
  if (existsSync(pythonExe) && !existsSync(python3Exe)) {
    copyFileSync(pythonExe, python3Exe);
    console.log("[pyruntime] 已生成 python3.exe");
  }

  rmSync(zipPath, { force: true });
  console.log("[pyruntime] 完成。");
}

main().catch((e) => {
  console.error("[pyruntime] 出错:", e.message);
  process.exit(1);
});
