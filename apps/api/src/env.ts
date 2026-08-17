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

// ===== 启动期聚合校验（P1.4）：保留上面按需的 loadXConfig 读取器不动，
// 这里只在真实进程入口（server.ts / workers）调用一次，测试不会触发。
// 分三档：
//   1. 启动必需 —— 缺一个就拒绝启动（fail-fast），避免「跑到一半才炸」。
//   2. 功能可选 —— 缺了对应功能降级/不可用，启动日志 warn 但不拦截。
//   3. 有默认值的调参 —— 代码里已有默认值兜底，这里不管。

/** 服务能响应请求的最低前提：DB、队列/缓存、JWT 签名。 */
export const REQUIRED_ENV: ReadonlyArray<{ key: string; hint: string }> = [
  { key: "DATABASE_URL", hint: "PostgreSQL 连接串（Prisma datasource）" },
  { key: "REDIS_URL", hint: "Redis 连接串（getRedis：任务队列/分布式锁）" },
  { key: "SESSION_SECRET", hint: "JWT 签名密钥（鉴权装饰器 verifyToken 用）" },
];

/** 功能可选：缺了则对应能力降级/不可用，仅 warn。 */
export const OPTIONAL_FEATURE_ENV: ReadonlyArray<{ key: string; hint: string }> = [
  { key: "BAILIAN_API_KEY", hint: "阿里云百炼 LLM（缺则对话不可用）" },
  { key: "ARK_API_KEY", hint: "火山方舟（豆包 Seedream 生图）" },
  { key: "GPT_IMAGE_API_KEY", hint: "GPT Image 生图" },
  { key: "EMBEDDING_API_KEY", hint: "知识库 embedding（缺则检索降级）" },
  { key: "MIMO_API_KEY", hint: "音频合成（MIMO）" },
  { key: "SKYHUMAN_API_TOKEN", hint: "视频数字人（SkyHuman）" },
  { key: "TOAPIS_API_KEY", hint: "视频解析（toapis）" },
];

/** 启动必需校验：缺失即打印明细并 process.exit(1)。仅真实进程入口调用。 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter(({ key }) => !process.env[key]?.trim());
  if (missing.length === 0) return;
  console.error("[env] 启动被拒绝：缺少必需环境变量：");
  for (const { key, hint } of missing) console.error(`  - ${key}  ${hint}`);
  console.error("[env] 请参考仓库根目录 .env.example 补齐后重试。");
  process.exit(1);
}

/** 功能可选缺失告警：启动时打 warn，不拦截启动。 */
export function warnMissingOptionalEnv(): void {
  for (const { key, hint } of OPTIONAL_FEATURE_ENV) {
    if (!process.env[key]?.trim()) {
      console.warn(`[env] 可选配置缺失 ${key}（${hint}）——对应功能将降级或不可用`);
    }
  }
}
