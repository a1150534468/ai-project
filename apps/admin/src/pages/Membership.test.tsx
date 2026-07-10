import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSession } from "../auth.js";
import * as api from "../api.js";
import { MembershipPage } from "./Membership.js";

vi.mock("../api.js", () => ({
  listMembershipCards: vi.fn(),
  listVipLevels: vi.fn(),
  upsertMembershipCard: vi.fn(),
  deleteMembershipCard: vi.fn(),
  upsertVipLevel: vi.fn(),
  deleteVipLevel: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  sessionStorage.clear();
  saveSession({
    token: "token",
    adminId: "admin-1",
    role: "admin",
    permissions: ["MEMBERSHIP_MANAGE"],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container.remove();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("MembershipPage", () => {
  it("keeps membership cards visible when vip levels fail to load", async () => {
    vi.mocked(api.listMembershipCards).mockResolvedValue([
      {
        id: 1,
        name: "专业月卡",
        priceFen: 9900,
        durationDays: 30,
        cadence: "MONTHLY",
        grantPoints: 1000,
        kbQuotaBytes: 0,
        enabled: true,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ]);
    vi.mocked(api.listVipLevels).mockRejectedValue(new Error("vip unavailable"));

    root = createRoot(container);
    await act(async () => {
      root.render(<MembershipPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain("专业月卡");
    expect(container.textContent).toContain("99.00");
    expect(container.textContent).toContain("vip unavailable");
  });
});
