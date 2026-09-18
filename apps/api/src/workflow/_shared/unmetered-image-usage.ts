/**
 * Image workflows predate removal of account billing. Keep their persisted operation
 * metadata compatible with surviving databases without resurrecting billing or making
 * any network calls. These values are bookkeeping only; every default price is zero.
 * An injected implementation remains available for legacy lifecycle regression tests.
 */
export class InsufficientBalanceError extends Error {
  constructor(message = "余额不足，请充值") {
    super(message);
  }
}

export function createUnmeteredImageUsage() {
  return {
    reserveResource: async (_args: unknown) => ({ reserved: 0 }),
    settleResource: async (_args: unknown) => ({ settled: 0 }),
    chargeResource: async (_args: unknown) => ({ charged: 0 }),
    refundResource: async (_operationId: string) => ({ success: true }),
    listResourcePrices: async () => ({ data: [] }),
    reserve: async (_args: unknown) => ({ reserved: 0 }),
    settle: async (_args: unknown) => ({ settled: 0 }),
  };
}
