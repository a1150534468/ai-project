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
//   1. 启动必需 —— 缺一个（或长度不达标）就拒绝启动（fail-fast），避免「跑到一半才炸」。
//      服务与 worker 的必需集不同：只有 HTTP 服务会注册后台路由，见 SERVER_REQUIRED_ENV。
//   2. 功能可选 —— 缺了对应功能降级/不可用，启动日志 warn 但不拦截；
//      有等价回落 key 的（如 EMBEDDING_API_KEY→BAILIAN_API_KEY）不报，否则是假警报。
//   3. 有默认值的调参 —— 代码里已有默认值兜底，这里不管。

export interface EnvRequirement {
  readonly key: string;
  readonly hint: string;
  /**
   * 下游对这个值有长度硬要求时填。只判「非空」是不够的：
   * `auth/routes.ts:23`、`admin/routes.ts:27`、`image-routes.ts:279`、
   * `codex-pet-storage.ts:96` 都写着
   * `length < 32 → throw`，其中前两处是**插件注册期**抛的。
   * 配一个 8 字节的 SESSION_SECRET，非空校验会放行，然后 buildServer() 照样炸——
   * 那就白做了这层聚合校验。
   */
  readonly minLength?: number;
  /** 同一能力的等价配置：任一有值就算配了，避免明明能用却报缺失。 */
  readonly alternates?: ReadonlyArray<string>;
}

/** 服务与 worker 共同的最低前提：DB、队列/缓存、JWT 签名。 */
export const REQUIRED_ENV: ReadonlyArray<EnvRequirement> = [
  { key: "DATABASE_URL", hint: "PostgreSQL 连接串（Prisma datasource）" },
  { key: "REDIS_URL", hint: "Redis 连接串（getRedis：任务队列/分布式锁）" },
  { key: "SESSION_SECRET", hint: "JWT 签名密钥（verifyToken + 各域 blob 签名）", minLength: 32 },
];

/**
 * HTTP 服务额外需要的：`server.ts` 无条件 `register(adminRoutes)`，
 * 而 `adminRoutes` 在注册期就校验 ADMIN_SESSION_SECRET ≥32 字节。
 * 缺它 = 服务起不来，属于「启动必需」档；worker 不注册后台路由，所以不并入 REQUIRED_ENV。
 */
export const SERVER_REQUIRED_ENV: ReadonlyArray<EnvRequirement> = [
  ...REQUIRED_ENV,
  { key: "ADMIN_SESSION_SECRET", hint: "后台 JWT 签名密钥（admin/reseller guard 用）", minLength: 32 },
];

/** 功能可选：缺了则对应能力降级/不可用，仅 warn。 */
export const OPTIONAL_FEATURE_ENV: ReadonlyArray<EnvRequirement> = [
  {
    key: "BAILIAN_API_KEY",
    hint: "阿里云百炼 LLM（缺则对话不可用）",
    alternates: ["DASHSCOPE_API_KEY"],
  },
  { key: "ARK_API_KEY", hint: "火山方舟（豆包 Seedream 生图）" },
  {
    key: "GPT_IMAGE_API_KEY",
    hint: "GPT Image 生图",
    alternates: ["CHATGPT_API_KEY"],
  },
  {
    key: "EMBEDDING_API_KEY",
    hint: "知识库 embedding（缺则检索降级）",
    // embedding-client.ts:26-29：EMBEDDING_API_KEY 空时按 provider 回落到百炼 key 或 LLM_API_KEY。
    alternates: ["BAILIAN_API_KEY", "DASHSCOPE_API_KEY", "LLM_API_KEY"],
  },
  { key: "MIMO_API_KEY", hint: "音频合成（MIMO）" },
];

/**
 * 纯函数：把不合法的项列成人话，空数组 = 全部合法。
 * 单独抽出来是为了能测——`assertRequiredEnv` 里有 `process.exit`，不适合直接断言。
 */
export function collectEnvProblems(
  requirements: ReadonlyArray<EnvRequirement>,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const { key, hint, minLength, alternates } of requirements) {
    const value = env[key]?.trim();
    if (!value) {
      if (alternates?.some((alt) => env[alt]?.trim())) continue;
      problems.push(`${key}  缺失 —— ${hint}`);
      continue;
    }
    if (minLength !== undefined && value.length < minLength) {
      problems.push(`${key}  太短（${value.length} 字节 < ${minLength}）—— ${hint}`);
    }
  }
  return problems;
}

/** 启动必需校验：不合法即打印明细并 process.exit(1)。仅真实进程入口调用。 */
export function assertRequiredEnv(
  requirements: ReadonlyArray<EnvRequirement> = REQUIRED_ENV,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems = collectEnvProblems(requirements, env);
  if (problems.length === 0) return;
  console.error("[env] 启动被拒绝：环境变量不合法：");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("[env] 请参考仓库根目录 .env.example 补齐后重试。");
  process.exit(1);
}

/** 功能可选缺失告警：启动时打 warn，不拦截启动。 */
export function warnMissingOptionalEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const problem of collectEnvProblems(OPTIONAL_FEATURE_ENV, env)) {
    console.warn(`[env] 可选配置 ${problem}——对应功能将降级或不可用`);
  }
}
