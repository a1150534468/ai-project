/**
 * 「一笔预留能被合法持有多久」的换算口径。
 *
 * billing 侧有一条兜底：`recon.Reconcile` 每 5 分钟把仍是 `reserved` 的 usage_records
 * 按 actual=0 关账，默认只给 **10 分钟**全局 TTL。窗口天生超过这个值的工作流必须在
 * reserve 时显式声明 `reservationTtlSeconds`，否则运行途中预留就被收走——之后
 * `wallet.Settle` 对非 reserved 记录**静默返回 nil**，调用方只拿到 0，全程无人报错。
 * 桌宠那笔 1600 点就是这么丢的（见 codex-pet-reservation-window.ts）。
 *
 * 因此两种失效方式的代价完全不对称：
 * - TTL 偏短 = 静默漏计费，数据层没有痕迹，只能靠人肉比对才发现；
 * - TTL 偏长 = 真正被遗弃的预留晚一点才自动退款。各域都有自己的 reaper/对账在约一分钟内
 *   给终态行结算或退款，能走到 TTL 的只有「确实还在跑」或「连 reaper 都没起来」的行。
 * 所以推导一律**往长的方向取整**，且 {@link reservationTtlSeconds} 保证结果不会短于
 * billing 的全局兜底——声明 TTL 只能延长窗口，绝不能比不声明还短。
 *
 * 本文件是**叶子模块**：不 import 任何东西，只做算术。各域的窗口口径留在各自的
 * `*-shared.ts`（那里才有该域的超时/重试常量），本文件只负责「知道 billing 那几个数」。
 */

/** billing `/resource/reserve` 的硬上限（maxReservationTTLSeconds），超出直接 400。 */
export const BILLING_MAX_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 不声明 TTL 时 billing 用的全局兜底（`recon.Reconcile(st, w, 10*time.Minute)`）。 */
export const BILLING_RECON_GLOBAL_TTL_MS = 10 * 60_000;

/** billing 兜底的扫描间隔（services/billing/main.go 的 ticker）。 */
export const BILLING_RECON_SCAN_INTERVAL_MS = 5 * 60_000;

/**
 * 余量：兜底是周期扫描而不是到点即触发，窗口结束到真正关账之间还有一个扫描间隔，
 * 再叠上 api 与 billing 两个进程的时钟偏差。给两个扫描间隔。
 */
const DEFAULT_RESERVATION_MARGIN_MS = 2 * BILLING_RECON_SCAN_INTERVAL_MS;

/**
 * 留给「被 reaper 捞回去续跑」的额外心跳间隔数。
 *
 * 续跑不会重新预留（reserve 在建行时就做完了），所以每一轮续跑都直接延长同一笔预留的寿命：
 * 一轮的代价是「等 reaper 判定卡单（≈1 个心跳间隔）+ 当前那一单位重做（≈1 个）」= 2 个间隔。
 * 默认 4 = 两轮，够盖一次滚动发布把进程掐掉两次。不续跑的域（图文 reaper 是收尸+退款、
 * 电商每次尝试各自预留）显式传 0，不要凭空加。
 */
const DEFAULT_RESERVATION_RESUME_ALLOWANCE = 4;

/**
 * 非上游耗时的余量倍数：下载、sharp 解析、S3 上传、入库都不在上游超时里。
 * 与 portraitTaskStaleMs / articleProjectStaleMs 用的是同一个倍数，故意保持一致。
 */
const NON_UPSTREAM_MARGIN_RATIO = 1.5;

function positiveNumber(key: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function reservationMarginMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber("BILLING_RESERVATION_MARGIN_MS", DEFAULT_RESERVATION_MARGIN_MS, env);
}

export function reservationResumeAllowance(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.BILLING_RESERVATION_RESUME_ALLOWANCE);
  // 0 是「这个域不续跑」的合法取值，所以不能用 positiveNumber。
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RESERVATION_RESUME_ALLOWANCE;
}

/**
 * 产出**一张**上游图的最坏耗时：每次尝试都要先过共享派发闸门（排队期间不写心跳），
 * 跑满尝试次数，中间隔着固定退避，最后乘非上游余量。
 *
 * 与 portraitTaskStaleMs / articleProjectStaleMs 里的算式同形——那两处盖的是「两次心跳的
 * 最长间隔」，这里盖的是「一张图的总耗时」，输入的重试预算各域不同，所以留在各域自己传。
 */
export function upstreamImageWorstMs(args: {
  readonly attemptTimeoutMs: number;
  readonly dispatchWaitMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}): number {
  const attempts = Math.max(1, args.maxAttempts);
  const attemptMs = args.attemptTimeoutMs + args.dispatchWaitMs;
  const backoffMs = Math.max(0, attempts - 1) * Math.max(0, args.retryDelayMs);
  return Math.round((attemptMs * attempts + backoffMs) * NON_UPSTREAM_MARGIN_RATIO);
}

/**
 * 把业务窗口换算成 `reservationTtlSeconds`。
 *
 * 窗口 = （要跨过的心跳数 + 续跑余量）× 单次心跳间隔的最坏耗时 + 与心跳无关的等待 + 兜底扫描余量。
 * 结果向上取整到秒，下限是 billing 全局兜底 + 余量，上限按 billing 硬上限截断——
 * 截断是有意的失败姿态：宁可让兜底晚于业务，也不要让 reserve 请求 400 把整条链路挡死。
 */
export function reservationTtlSeconds(args: {
  /** 单次心跳间隔的最坏耗时。各域已有的卡单阈值就是这个数。 */
  readonly perHeartbeatMs: number;
  /** 一笔预留要跨过多少次心跳间隔（生图 = 张数 × 尝试次数，人像 = 张数，图文 = 文本 + 出图批次）。 */
  readonly heartbeats: number;
  /** 续跑余量，省略时用默认；确定不会被续跑的域传 0。 */
  readonly resumeAllowance?: number;
  /** 窗口里与心跳无关的那一段等待，例如小说任务在 worker 接手前的排队。 */
  readonly extraWindowMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}): number {
  const env = args.env ?? process.env;
  const marginMs = reservationMarginMs(env);
  const allowance = args.resumeAllowance ?? reservationResumeAllowance(env);
  const intervals = Math.max(1, args.heartbeats) + Math.max(0, allowance);
  const windowMs = Math.max(0, args.perHeartbeatMs) * intervals + Math.max(0, args.extraWindowMs ?? 0);
  const totalMs = Math.max(windowMs, BILLING_RECON_GLOBAL_TTL_MS) + marginMs;
  return Math.min(Math.ceil(totalMs / 1000), BILLING_MAX_RESERVATION_TTL_SECONDS);
}
