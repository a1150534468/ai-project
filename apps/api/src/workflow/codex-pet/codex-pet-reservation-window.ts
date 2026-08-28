/**
 * 桌宠按图计费「预留能被合法持有多久」的单一来源。
 *
 * billing 侧有一条兜底：`recon.Reconcile` 每 5 分钟把仍是 `reserved` 的 usage_records
 * 按 actual=0 强行关账。它原本只认一个全局 10 分钟 TTL，而桌宠的一笔预留天生要跨越
 * 「运行 + 等待用户授权（7 天）+ 失败结算宽限（24 小时）」——于是运行途中预留就被收走：
 * 之后每次真实出图都按 0 结算，调用方 settle 也只拿到静默的 0，是一次无人报错的漏计费
 * （cpr_2defdce20f99dd1a8dd3477f774de2f8 就是这么丢了 1600 点）。
 *
 * 所以预留时必须把这个窗口显式告诉 billing（`reservationTtlSeconds`）。窗口口径只能有
 * 一份：worker 用它决定何时收尸，routes 用它声明预留有效期，两边必须同源，否则兜底又会
 * 早于业务动手。
 */

const DEFAULT_PARKED_APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FAILED_SETTLEMENT_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_RESERVATION_MARGIN_MS = 12 * 60 * 60_000;

/** billing `/resource/reserve` 的硬上限（maxReservationTTLSeconds），超出会 400。 */
const BILLING_MAX_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

function positiveNumber(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * How long a run may sit in `awaiting_regeneration_approval` before maintenance
 * cancels it.
 *
 * `recoverStaleRuns` deliberately never touches an approval-waiting run: nobody
 * should re-enqueue work the user has not authorised. But without any expiry
 * that wait had no end, which left two debts: its 14-unit reservation was held
 * open indefinitely (the settlement reconciler only considers terminal runs),
 * and the run stayed wake-able forever — so a user who moved on to a new project
 * could later approve the zombie and have both runs hit the same relay quota at
 * once, which is exactly the 429 shape that killed an earlier run.
 *
 * Cancelling is the conservative resolution: it is the same transition the user
 * could make by hand, it settles only the units actually delivered, and it
 * leaves every artifact in place.
 */
export const CODEX_PET_PARKED_APPROVAL_EXPIRY_MS = positiveNumber(
  "CODEX_PET_PARKED_APPROVAL_EXPIRY_MS",
  DEFAULT_PARKED_APPROVAL_EXPIRY_MS,
);

/**
 * A worker can finish the artifact work yet lose connectivity while settling
 * its reservation. Settlement is irreversible: every resume path requires
 * billingSettlementStatus="reserved", so settling condemns the run forever.
 * `ready`/`cancelled` are genuine user-owned terminals and settle at once, but
 * a failure is frequently just a fixable bug sitting on top of intact paid
 * artifacts, so failed runs keep their reservation for a grace window and are
 * only settled once nobody has resumed them. Units are recounted from the call
 * ledger at settle time, so settling late is strictly more accurate.
 */
export const CODEX_PET_FAILED_SETTLEMENT_GRACE_MS = positiveNumber(
  "CODEX_PET_FAILED_SETTLEMENT_GRACE_MS",
  DEFAULT_FAILED_SETTLEMENT_GRACE_MS,
);

/**
 * 余量：兜底任务是周期扫描而不是到点即触发，宽限期结束到真正结算之间还有一个扫描间隔，
 * 再叠上两个进程的时钟偏差。余量不足会让 billing 的兜底抢在业务结算之前动手。
 */
export const CODEX_PET_RESERVATION_MARGIN_MS = positiveNumber(
  "CODEX_PET_RESERVATION_MARGIN_MS",
  DEFAULT_RESERVATION_MARGIN_MS,
);

/**
 * 预留有效期（秒）= 等授权上限 + 失败结算宽限 + 余量，按 billing 上限截断。
 *
 * 截断是有意的失败姿态：把 env 调到超过 30 天时，宁可让兜底晚于业务、也不要让预留请求
 * 直接 400 —— 后者会让整条运行无法起步。
 */
export function codexPetReservationTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const totalMs =
    positiveNumber("CODEX_PET_PARKED_APPROVAL_EXPIRY_MS", DEFAULT_PARKED_APPROVAL_EXPIRY_MS, env) +
    positiveNumber("CODEX_PET_FAILED_SETTLEMENT_GRACE_MS", DEFAULT_FAILED_SETTLEMENT_GRACE_MS, env) +
    positiveNumber("CODEX_PET_RESERVATION_MARGIN_MS", DEFAULT_RESERVATION_MARGIN_MS, env);
  return Math.min(Math.ceil(totalMs / 1000), BILLING_MAX_RESERVATION_TTL_SECONDS);
}
