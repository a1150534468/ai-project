export interface EnvRequirement {
  readonly key: string;
  readonly hint: string;
  readonly minLength?: number;
  readonly alternates?: readonly string[];
}

export const REQUIRED_ENV: readonly EnvRequirement[] = [
  { key: "DATABASE_URL", hint: "PostgreSQL 连接串（Prisma datasource）" },
  { key: "REDIS_URL", hint: "Redis 连接串（getRedis：任务队列/分布式锁）" },
  { key: "SESSION_SECRET", hint: "JWT 签名密钥（verifyToken + 各域 blob 签名）", minLength: 32 },
];

export const SERVER_REQUIRED_ENV: readonly EnvRequirement[] = [
  ...REQUIRED_ENV,
  { key: "ADMIN_SESSION_SECRET", hint: "后台 JWT 签名密钥（admin guard 用）", minLength: 32 },
];

export const OPTIONAL_FEATURE_ENV: readonly EnvRequirement[] = [
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
    alternates: ["BAILIAN_API_KEY", "DASHSCOPE_API_KEY", "LLM_API_KEY"],
  },
];

function configured(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function collectEnvProblems(
  requirements: readonly EnvRequirement[],
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return requirements.flatMap(({ key, hint, minLength, alternates }) => {
    const value = configured(env, key);
    if (!value) {
      if (alternates?.some((alternate) => configured(env, alternate))) return [];
      return [`${key}  缺失 —— ${hint}`];
    }
    if (minLength !== undefined && value.length < minLength) {
      return [`${key}  太短（${value.length} 字节 < ${minLength}）—— ${hint}`];
    }
    return [];
  });
}

export function assertRequiredEnv(
  requirements: readonly EnvRequirement[] = REQUIRED_ENV,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems = collectEnvProblems(requirements, env);
  if (problems.length === 0) return;
  console.error("[env] 启动被拒绝：环境变量不合法：");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("[env] 请参考仓库根目录 .env.example 补齐后重试。");
  process.exit(1);
}

export function warnMissingOptionalEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const problem of collectEnvProblems(OPTIONAL_FEATURE_ENV, env)) {
    console.warn(`[env] 可选配置 ${problem}——对应功能将降级或不可用`);
  }
}
