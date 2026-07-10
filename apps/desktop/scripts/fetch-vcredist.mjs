// 下载 VC++ 2015-2022 x64 运行库到 build/vc_redist.x64.exe，供 NSIS 装包时静默安装（兜底）。
// 打包前自动运行（见 package.json 的 dist:win）；已存在则跳过，避免重复下载。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "build");
const outFile = join(outDir, "vc_redist.x64.exe");

async function main() {
  if (existsSync(outFile)) {
    console.log(`[vcredist] 已存在 ${outFile}，跳过下载。`);
    return;
  }
  mkdirSync(outDir, { recursive: true });

  console.log(`[vcredist] 下载 ${URL}`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outFile, buf);
  console.log(`[vcredist] 已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error("[vcredist] 出错:", e.message);
  process.exit(1);
});
