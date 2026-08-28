import { describe, expect, it } from "vitest";
import { codexPetReservationTtlSeconds } from "./codex-pet-reservation-window.js";

const DAY_SECONDS = 24 * 60 * 60;

describe("codexPetReservationTtlSeconds", () => {
  it("默认窗口必须盖住等授权 7 天 + 失败结算宽限 24 小时", () => {
    // 覆盖不住就等于 billing 兜底会在运行仍合法持有预留时把它关掉，
    // 之后每次真实出图都按 0 结算且无人报错。
    expect(codexPetReservationTtlSeconds({})).toBeGreaterThan(8 * DAY_SECONDS);
    expect(codexPetReservationTtlSeconds({})).toBeLessThanOrEqual(30 * DAY_SECONDS);
  });

  it("三个窗口都从 env 读，任一放宽都会同步放宽预留有效期", () => {
    const base = codexPetReservationTtlSeconds({});
    expect(
      codexPetReservationTtlSeconds({ CODEX_PET_PARKED_APPROVAL_EXPIRY_MS: String(14 * DAY_SECONDS * 1000) }),
    ).toBe(base + 7 * DAY_SECONDS);
    expect(
      codexPetReservationTtlSeconds({ CODEX_PET_FAILED_SETTLEMENT_GRACE_MS: String(2 * DAY_SECONDS * 1000) }),
    ).toBe(base + DAY_SECONDS);
    expect(codexPetReservationTtlSeconds({ CODEX_PET_RESERVATION_MARGIN_MS: String(DAY_SECONDS * 1000) })).toBe(
      base + DAY_SECONDS / 2,
    );
  });

  it("非法 env 回退到默认值，不会把有效期缩成 0", () => {
    for (const value of ["0", "-1", "abc", ""]) {
      expect(codexPetReservationTtlSeconds({ CODEX_PET_PARKED_APPROVAL_EXPIRY_MS: value })).toBe(
        codexPetReservationTtlSeconds({}),
      );
    }
  });

  it("超过 billing 30 天上限时截断，而不是让预留请求直接 400", () => {
    expect(
      codexPetReservationTtlSeconds({ CODEX_PET_PARKED_APPROVAL_EXPIRY_MS: String(90 * DAY_SECONDS * 1000) }),
    ).toBe(30 * DAY_SECONDS);
  });
});
