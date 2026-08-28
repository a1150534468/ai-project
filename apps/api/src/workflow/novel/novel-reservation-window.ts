/**
 * 小说任务「预留能被合法持有多久」的单一来源。
 *
 * 这是全仓风险最高的一处预留：`reserveAndCreateTask` 在**建行时**就下预留，之后任务只是
 * 进 `queued` 等 Novel Worker 来接，真正的结算发生在 worker 生成完之后。也就是说预留的寿命
 * 不由我们这边的耗时决定，而由「worker 什么时候来接」决定——worker 停机、outbox 派发卡住、
 * `recoverInterruptedNovelTasks` 反复重排（那里没有重试上限）都会把这个窗口拉长。
 *
 * 而 billing 的兜底只给 10 分钟全局 TTL：worker 停机超过 10 分钟，预留就被按 actual=0 关账，
 * 等 worker 回来生成完，`wallet.Settle` 对非 reserved 记录静默返回 nil、这边只拿到 0，
 * 用户白拿一章、账上没有任何异常痕迹。这正是桌宠丢掉 1600 点的同一条路径。
 *
 * 所以这里的窗口是一个**明写的运维预算**，不是从超时推出来的：worker 连续停机多久，我们仍
 * 愿意为这笔预留背书。取 7 天（与桌宠等授权窗口同一量级，且离 billing 的 30 天硬上限还有余地）。
 * 两种失效方式的代价不对称，才这么取：
 * - 窗口偏短 = 静默漏计费，库里查不出来；
 * - 窗口偏长 = 一个始终没被派发的任务多占用户几天点数，而任务行一直显示「已入队」，
 *   用户随时可以取消（取消走退款），是可见、可自救的。
 */

import { reservationTtlSeconds } from "../_shared/reservation-window.js";

/** worker 停机预算：超过这个时长仍没接手，就宁可让 billing 兜底把预留退掉。 */
const DEFAULT_WORKER_OUTAGE_BUDGET_MS = 7 * 24 * 60 * 60_000;

/**
 * 单次文本生成的最坏耗时。novel 这条链自己不重试（generator 抛错就退款置 failed），
 * 兜底重试来自 Anthropic SDK：默认单请求超时 10 分钟、`maxRetries` 2，即最多 3 次。
 */
const DEFAULT_GENERATION_TIMEOUT_MS = 600_000;
const DEFAULT_GENERATION_MAX_ATTEMPTS = 3;

function positiveNumber(key: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function novelWorkerOutageBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber("NOVEL_WORKER_OUTAGE_BUDGET_MS", DEFAULT_WORKER_OUTAGE_BUDGET_MS, env);
}

/**
 * 预留有效期（秒）= worker 停机预算 + 一次生成的最坏耗时（含续跑余量）。
 *
 * 心跳间隔用「单次生成的最坏耗时」：流式生成期间 runner 每隔一会儿写一次进度，
 * `recoverInterruptedNovelTasks` 按 updatedAt 判断中断，判断成立就重排——重排不会重新预留，
 * 直接延长同一笔预留，所以续跑余量走默认。
 */
export function novelReservationTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const attempts = positiveNumber("NOVEL_GENERATION_MAX_ATTEMPTS", DEFAULT_GENERATION_MAX_ATTEMPTS, env);
  const timeoutMs = positiveNumber("NOVEL_GENERATION_TIMEOUT_MS", DEFAULT_GENERATION_TIMEOUT_MS, env);
  return reservationTtlSeconds({
    perHeartbeatMs: timeoutMs * attempts,
    heartbeats: 1,
    extraWindowMs: novelWorkerOutageBudgetMs(env),
    env,
  });
}
