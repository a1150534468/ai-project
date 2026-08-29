/**
 * chat/routes.ts 拆分后的运行期常量与环境变量读取。
 *
 * `CHAT_RESERVE_OUTPUT_TOKENS` 是预扣口径,不是输出上限:真正的单次输出上限由
 * routes-model-gate.ts 的 `resolveModelMaxOutput` 从计费侧配置读。改这个常量只会改变"先冻结多少
 * 点数",最终结算仍按实际用量多退少补。
 *
 * `DEFAULT_KB_*` 四个默认值都能被同名环境变量覆盖(`KB_TOPK` / `KB_MIN_SCORE` /
 * `KB_MAX_CONTEXT_CHUNKS` / `KB_MAX_CHUNKS_PER_DOCUMENT`),覆盖发生在路由里而不是这里 —— 这里
 * 只给"没配置时"的落点。
 *
 * `SSE_HEARTBEAT_MS` 的 15s 要小于任何一层代理的空闲超时,否则长回答会在网关处被静默掐断,
 * 前端只看到连接断开而没有 error 事件。
 *
 * `positiveNumberEnv` / `positiveIntEnv` 对 NaN、0、负数一律退回 fallback。这是刻意的:一个写错的
 * 环境变量应当退化成默认值,而不是让 KB 检索拿到 topK=0 静默返回空结果。
 *
 * 依赖方向:本文件是叶子,不 import 任何本仓模块。
 */

// 预扣统一按 10000 token 的输出价计算（Go 侧按模型输出单价换算成算力点）。
export const CHAT_RESERVE_OUTPUT_TOKENS = 10_000;
export const DEFAULT_KB_MIN_SCORE = 0.35;
export const DEFAULT_KB_TOPK = 8;
export const DEFAULT_KB_MAX_CONTEXT_CHUNKS = 4;
export const DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT = 2;
export const SSE_HEARTBEAT_MS = 15_000;

export function positiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function positiveIntEnv(name: string, fallback: number): number {
  return Math.floor(positiveNumberEnv(name, fallback));
}
