import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QuickRechargePackageCard, calculateRechargePackageBonus } from "./QuickRechargePackageCard";

describe("calculateRechargePackageBonus", () => {
  it("calculates gifted points against the custom recharge ratio", () => {
    expect(calculateRechargePackageBonus(600, 660, 100)).toBe(60);
  });

  it("does not report a gift when the package is not better than custom recharge", () => {
    expect(calculateRechargePackageBonus(600, 600, 100)).toBe(0);
    expect(calculateRechargePackageBonus(600, 580, 100)).toBe(0);
  });
});

describe("QuickRechargePackageCard", () => {
  it("renders the campaign gift label when the package includes bonus points", () => {
    const html = renderToStaticMarkup(
      <QuickRechargePackageCard
        pkg={{ id: "promo", name: "活动包", amountFen: 600, points: 660, enabled: true, sortOrder: 10 }}
        index={0}
        rechargeRatio={100}
        loading={false}
        onTopup={vi.fn()}
      />,
    );

    expect(html).toContain("活动赠送 60 点");
    expect(html).toContain("text-red-600");
  });
});
