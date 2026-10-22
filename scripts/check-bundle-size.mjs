#!/usr/bin/env node
/**
 * 首屏体积预算：apps/web/dist/assets 里任何单个 JS chunk 的 gzip 体积
 * 超过阈值就失败。
 *
 * 为什么需要它：页面级 lazy + manualChunks 拆分之前，全部 JS 在一个
 * 1,445.9 KB（gzip 424.7 KB）的 chunk 里，首屏必须下完才出画面。
 * 拆分本身是一次性收益，没有预算守着，下一次静态 import 就能把它涨回去，
 * 而且没人会注意到 —— 所以把「单一 chunk gzip ≤ 350 KB」写成 CI 门禁
 * （static job 里 build 之后跑本脚本）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ASSETS_DIR = join(process.cwd(), "apps", "web", "dist", "assets");
const MAX_CHUNK_GZIP_BYTES = 350 * 1024;

let files;
try {
  files = readdirSync(ASSETS_DIR).filter((name) => name.endsWith(".js"));
} catch {
  console.error(`找不到构建产物目录：${ASSETS_DIR}（先跑 pnpm --filter @ai-assistant/web build）`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`构建产物为空：${ASSETS_DIR}`);
  process.exit(1);
}

let failed = false;
for (const name of files.sort()) {
  const raw = readFileSync(join(ASSETS_DIR, name));
  const gzipped = gzipSync(raw).length;
  const over = gzipped > MAX_CHUNK_GZIP_BYTES;
  if (over) failed = true;
  console.log(
    `${over ? "✗" : "✓"} ${name}: raw ${(raw.length / 1024).toFixed(1)} KB, gzip ${(gzipped / 1024).toFixed(1)} KB` +
      (over ? `（超过单一 chunk 预算 ${(MAX_CHUNK_GZIP_BYTES / 1024).toFixed(0)} KB gzip）` : ""),
  );
}
if (failed) {
  console.error("bundle 体积超限：拆 lazy / manualChunks，别调大阈值掩盖问题。");
  process.exit(1);
}
console.log(`bundle 体积 OK：${files.length} 个 chunk，单个 gzip 均 ≤ ${(MAX_CHUNK_GZIP_BYTES / 1024).toFixed(0)} KB`);
