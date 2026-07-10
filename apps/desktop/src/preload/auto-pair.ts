export interface AutoPairController {
  readonly checkNow: () => Promise<void>;
}

export interface AutoPairDeps {
  readonly getSessionToken: () => string | null;
  readonly pairSessionToken: (token: string) => Promise<unknown>;
  readonly logger: Pick<Console, "warn">;
}

interface AutoPairState {
  pairedToken: string | null;
  inFlightToken: string | null;
}

function normalizeToken(token: string | null): string | null {
  const trimmed = token?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function createAutoPairController(deps: AutoPairDeps): AutoPairController {
  const state: AutoPairState = {
    pairedToken: null,
    inFlightToken: null,
  };

  return {
    async checkNow(): Promise<void> {
      const token = normalizeToken(deps.getSessionToken());
      if (!token || token === state.pairedToken || token === state.inFlightToken) {
        return;
      }

      state.inFlightToken = token;
      try {
        await deps.pairSessionToken(token);
        state.pairedToken = token;
      } catch (error) {
        deps.logger.warn("[desktop] auto-pair failed", error);
      } finally {
        state.inFlightToken = null;
      }
    },
  };
}
