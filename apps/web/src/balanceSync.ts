export const PAYMENT_BALANCE_POLL_INTERVAL_MS = 3000;
export const PAYMENT_BALANCE_POLL_MAX_ATTEMPTS = 40;

type TimerId = number | ReturnType<typeof setTimeout>;

export interface PaymentBalancePollingOptions {
  readonly refresh: () => Promise<void> | void;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerId;
  readonly cancel?: (timerId: TimerId) => void;
}

export function formatBalanceLabel(balance: number | null): string {
  if (balance === null) return "同步中";
  return `${balance.toLocaleString()} 点`;
}

export function startPaymentBalancePolling(options: PaymentBalancePollingOptions): () => void {
  const intervalMs = options.intervalMs ?? PAYMENT_BALANCE_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? PAYMENT_BALANCE_POLL_MAX_ATTEMPTS;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let attempts = 0;
  let stopped = false;
  let timerId: TimerId | undefined;

  const tick = () => {
    if (stopped || attempts >= maxAttempts) return;
    attempts += 1;
    Promise.resolve(options.refresh()).finally(() => {
      if (!stopped && attempts < maxAttempts) {
        timerId = schedule(tick, intervalMs);
      }
    });
  };

  timerId = schedule(tick, intervalMs);

  return () => {
    stopped = true;
    if (timerId !== undefined) cancel(timerId);
  };
}
