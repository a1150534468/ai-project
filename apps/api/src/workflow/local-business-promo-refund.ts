import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { createBillingClient } from "@yc/billing";
import type { RunRow } from "./local-business-promo-route-types.js";

export const LOCAL_BUSINESS_PROMO_REFUND_STATUS_NONE = "none";
export const LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING = "pending";
export const LOCAL_BUSINESS_PROMO_REFUND_STATUS_REFUNDED = "refunded";
const LOCAL_BUSINESS_PROMO_REFUND_REAPER_LOCK_KEY = "yunclaude:local-business-promo:refund-reaper:lock";

export type BillingForLocalBusinessPromoRefund = Pick<ReturnType<typeof createBillingClient>, "refundResource">;

export interface LocalBusinessPromoRefundAttemptResult {
  readonly status: typeof LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING | typeof LOCAL_BUSINESS_PROMO_REFUND_STATUS_REFUNDED;
  readonly error: string | null;
  readonly refundedAt: Date | null;
  readonly attemptedAt: Date;
  readonly retryCount: number;
  readonly nextRetryAt: Date | null;
  readonly patch: {
    readonly billingRefundedAt?: Date;
    readonly billingRefundStatus: typeof LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING | typeof LOCAL_BUSINESS_PROMO_REFUND_STATUS_REFUNDED;
    readonly billingRefundError: string | null;
    readonly billingRefundRetryCount: number;
    readonly billingRefundLastAttemptAt: Date;
    readonly billingRefundNextRetryAt: Date | null;
  };
}

function loadNumber(envKey: string, fallback: number): number {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeRefundErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "退款失败";
}

function refundRetryDelayMs(retryCount: number): number {
  const baseMs = Math.max(10_000, loadNumber("LOCAL_BUSINESS_PROMO_REFUND_RETRY_BASE_MS", 60_000));
  const maxMs = Math.max(baseMs, loadNumber("LOCAL_BUSINESS_PROMO_REFUND_RETRY_MAX_MS", 15 * 60_000));
  const multiplier = 2 ** Math.max(0, retryCount - 1);
  return Math.min(maxMs, baseMs * multiplier);
}

function refundRetryAt(retryCount: number, now: Date): Date {
  return new Date(now.getTime() + refundRetryDelayMs(retryCount));
}

function refundLeaseUntil(now: Date): Date {
  return new Date(now.getTime() + Math.max(30_000, loadNumber("LOCAL_BUSINESS_PROMO_REFUND_REAPER_LEASE_MS", 2 * 60_000)));
}

function refundReaperIntervalMs(): number {
  return Math.max(30_000, loadNumber("LOCAL_BUSINESS_PROMO_REFUND_REAPER_INTERVAL_MS", 60_000));
}

export function buildPendingRefundMarker(message: string, now = new Date()) {
  return {
    billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING,
    billingRefundError: message,
    billingRefundNextRetryAt: now,
  } as const;
}

function resolveBillingClient(args: {
  readonly billing?: BillingForLocalBusinessPromoRefund;
  readonly fetchFn?: typeof fetch;
}): BillingForLocalBusinessPromoRefund {
  return args.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
    fetchFn: args.fetchFn,
  });
}

export async function attemptLocalBusinessPromoRefund(args: {
  readonly run: Pick<RunRow, "billingOperationId" | "billingRefundedAt" | "billingRefundRetryCount">;
  readonly billing?: BillingForLocalBusinessPromoRefund;
  readonly fetchFn?: typeof fetch;
  readonly now?: Date;
}): Promise<LocalBusinessPromoRefundAttemptResult | null> {
  if (!args.run.billingOperationId || args.run.billingRefundedAt) return null;
  const attemptedAt = args.now ?? new Date();
  const retryCount = (args.run.billingRefundRetryCount ?? 0) + 1;
  const billing = resolveBillingClient(args);
  try {
    await billing.refundResource(args.run.billingOperationId);
    return {
      status: LOCAL_BUSINESS_PROMO_REFUND_STATUS_REFUNDED,
      error: null,
      refundedAt: attemptedAt,
      attemptedAt,
      retryCount,
      nextRetryAt: null,
      patch: {
        billingRefundedAt: attemptedAt,
        billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_REFUNDED,
        billingRefundError: null,
        billingRefundRetryCount: retryCount,
        billingRefundLastAttemptAt: attemptedAt,
        billingRefundNextRetryAt: null,
      },
    };
  } catch (error) {
    const message = safeRefundErrorMessage(error);
    return {
      status: LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING,
      error: message,
      refundedAt: null,
      attemptedAt,
      retryCount,
      nextRetryAt: refundRetryAt(retryCount, attemptedAt),
      patch: {
        billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING,
        billingRefundError: message,
        billingRefundRetryCount: retryCount,
        billingRefundLastAttemptAt: attemptedAt,
        billingRefundNextRetryAt: refundRetryAt(retryCount, attemptedAt),
      },
    };
  }
}

export async function reapPendingLocalBusinessPromoRefunds(args: {
  readonly prisma: PrismaClient;
  readonly billing?: BillingForLocalBusinessPromoRefund;
  readonly fetchFn?: typeof fetch;
  readonly batchSize?: number;
  readonly now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  const runs = await args.prisma.localBusinessPromoRun.findMany({
    where: {
      status: "failed",
      billingOperationId: { not: null },
      billingRefundedAt: null,
      billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING,
      billingRefundNextRetryAt: { lte: now },
    },
    orderBy: { billingRefundNextRetryAt: "asc" },
    take: args.batchSize ?? 20,
  });
  let processed = 0;
  for (const run of runs) {
    const claimed = await args.prisma.localBusinessPromoRun.updateMany({
      where: {
        id: run.id,
        billingRefundedAt: null,
        billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_PENDING,
        billingRefundNextRetryAt: run.billingRefundNextRetryAt,
      },
      data: {
        billingRefundNextRetryAt: refundLeaseUntil(now),
      },
    }).catch(() => ({ count: 0 }));
    if (claimed.count !== 1) continue;
    const result = await attemptLocalBusinessPromoRefund({
      run,
      billing: args.billing,
      fetchFn: args.fetchFn,
      now,
    });
    if (!result) continue;
    await args.prisma.localBusinessPromoRun.update({
      where: { id: run.id },
      data: result.patch,
    }).catch(() => undefined);
    processed += 1;
  }
  return processed;
}

export function startLocalBusinessPromoRefundReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly billing?: BillingForLocalBusinessPromoRefund;
  readonly fetchFn?: typeof fetch;
}): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(LOCAL_BUSINESS_PROMO_REFUND_REAPER_LOCK_KEY, "1", "EX", 55, "NX");
    if (got !== "OK") return;
    try {
      await reapPendingLocalBusinessPromoRefunds(args);
    } catch {
      // leave for next cycle
    }
  };
  const timer = setInterval(() => void tick(), refundReaperIntervalMs());
  timer.unref();
  return timer;
}
