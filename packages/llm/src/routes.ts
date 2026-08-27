/**
 * 路由/凭据解析在三处被复刻过（client.ts 的 loadModelRoutes、codex-pet 的
 * model-contract 与 visual），语义相同但消息各不相同。这里收敛成单一实现，并给
 * 每种失败一个稳定的 `code`：调用方各自的领域错误（例如
 * `CodexPetModelContractError`）需要逐字保留自己的消息文本，靠 code 映射而不是
 * 直接透传 message，才能在收敛后不改变任何运维可见字符串。
 *
 * 三个常量/工具从 client.ts 移到这里，是为了让依赖方向只有 client → routes 一
 * 条边：`loadModelRoutes` 必须用到这里的解析函数，若常量留在 client.ts 就会形
 * 成模块环。client.ts 对外继续 re-export 它们，公开 API 不变。
 */
export const CHATGPT_MODELS = [
  "codex-auto-review",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;
export const CHATGPT_DEFAULT_BASE_URL = "https://api.ai-pixel.online";

export function buildBailianBaseURL(workspaceId: string, region = "cn-beijing"): string {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedRegion = region.trim();
  if (!normalizedWorkspaceId) throw new Error("BAILIAN_WORKSPACE_ID is required");
  if (!normalizedRegion) throw new Error("BAILIAN_REGION is required");
  return `https://${normalizedWorkspaceId}.${normalizedRegion}.maas.aliyuncs.com/apps/anthropic`;
}

export type LlmRouteErrorCode =
  | "chatgpt_api_key_missing"
  | "bailian_base_url_missing"
  | "bailian_api_key_missing";

export class LlmRouteError extends Error {
  constructor(readonly code: LlmRouteErrorCode, message: string) {
    super(message);
    this.name = "LlmRouteError";
  }
}

export interface LlmRouteCredentials {
  readonly baseURL: string;
  readonly apiKey: string;
}

/**
 * `CHATGPT_MODELS` 未配置、或配置后逐项去空白仍为空，都回退内置名单——三处复刻
 * 的判定 (`configured?.length ? configured : CHATGPT_MODELS`) 逐字一致。
 */
export function parseChatgptModelList(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = env.CHATGPT_MODELS?.split(",").map((model) => model.trim()).filter(Boolean);
  return configured?.length ? configured : CHATGPT_MODELS;
}

export function resolveChatgptCredentials(env: NodeJS.ProcessEnv = process.env): LlmRouteCredentials {
  const apiKey = env.CHATGPT_API_KEY?.trim() || env.GPT_IMAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmRouteError("chatgpt_api_key_missing", "CHATGPT_API_KEY or GPT_IMAGE_API_KEY is required");
  }
  return { baseURL: env.CHATGPT_BASE_URL?.trim() || CHATGPT_DEFAULT_BASE_URL, apiKey };
}

/**
 * 端点先于 key 判定，与 `loadLlmConfig` 的 bailian 分支和 codex-pet 的
 * `loadCodexPetVisualQaRoute` 一致（两者都是先 baseURL 后 apiKey）。
 *
 * region 用 `??` 而不是 `?.trim() ||`：显式配成空串时要继续落到
 * `buildBailianBaseURL` 抛出的普通 `Error("BAILIAN_REGION is required")`，那是
 * 配置写错而不是路由缺失，不能被吞成 `LlmRouteError` 让调用方当成缺配置处理。
 */
export function resolveBailianCredentials(env: NodeJS.ProcessEnv = process.env): LlmRouteCredentials {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim() || "";
  const baseURL = env.BAILIAN_BASE_URL?.trim()
    || (workspaceId ? buildBailianBaseURL(workspaceId, env.BAILIAN_REGION ?? "cn-beijing") : "");
  if (!baseURL) {
    throw new LlmRouteError("bailian_base_url_missing", "BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL is required");
  }
  const apiKey = env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmRouteError("bailian_api_key_missing", "BAILIAN_API_KEY or DASHSCOPE_API_KEY is required");
  }
  return { baseURL, apiKey };
}
