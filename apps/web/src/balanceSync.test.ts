import { describe, expect, it, vi } from "vitest";
import { formatBalanceLabel, startPaymentBalancePolling } from "./balanceSync";

describe("balance sync", () => {
  it("shows syncing instead of 0 when balance is still unknown", () => {
    expect(formatBalanceLabel(null)).toBe("同步中");
    expect(formatBalanceLabel(0)).toBe("0 点");
    expect(formatBalanceLabel(100764)).toBe("100,764 点");
  });

  it("polls balance after a payment QR code is created", async () => {
    const callbacks: Array<() => void> = [];
    const refresh = vi.fn(async () => {});
    const stop = startPaymentBalancePolling({
      refresh,
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: vi.fn(),
      intervalMs: 3000,
      maxAttempts: 2,
    });

    expect(refresh).not.toHaveBeenCalled();
    callbacks[0]?.();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    callbacks[1]?.();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    expect(callbacks).toHaveLength(2);
    stop();
  });
});
