import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import Billing, {
  PaymentStatusPanel,
  paymentMethodLabel,
  paymentSuccessMessage,
  usageDiscountLabel,
  usagePointLabel,
  usageTypeLabel,
} from "./Billing";
import { RechargeTab } from "./billing/RechargeTab";
import type { UsageRow } from "../api";

function usageRow(overrides: Partial<UsageRow>): UsageRow {
  return {
    operationId: "op-1",
    type: "novel_text_output",
    model: "novel_text_output",
    displayName: "小说文字生成",
    status: "reserved",
    reservedPoints: 3,
    actualPoints: 0,
    createdAt: "2026-07-01T05:20:22.000Z",
    settledAt: null,
    ...overrides,
  };
}

describe("usage labels", () => {
  it("labels video usage as video points", () => {
    expect(usagePointLabel(usageRow({ type: "video", status: "settled", reservedPoints: 300, actualPoints: 300 })))
      .toBe("-300 视频点");
  });

  it("labels 帮我写脚本生成 as 脚本生成扣费", () => {
    expect(usageTypeLabel(usageRow({ type: "video-script" }))).toBe("脚本生成扣费");
  });

  it("shows original and vip-discounted settled points", () => {
    expect(usageDiscountLabel(usageRow({
      status: "settled",
      actualPoints: 90,
      originalPoints: 100,
      vipLevelName: "银卡会员",
      vipDiscountBps: 9000,
    }))).toBe("银卡会员 9 折 · 原扣 100 点 · 实扣 90 点");
  });
});

describe("payment method and status panel", () => {
  it("labels supported payment methods for user choice", () => {
    expect(paymentMethodLabel("alipay")).toBe("支付宝");
    expect(paymentMethodLabel("wxpay")).toBe("微信支付");
  });

  it("renders QR instructions for the selected payment method", () => {
    const html = renderToStaticMarkup(
      React.createElement(PaymentStatusPanel, {
        state: "pending",
        payUrl: "https://pay.example/qr",
        method: "wxpay",
        refreshing: false,
        onClose: () => {},
        onRefresh: () => {},
      }),
    );

    expect(html).toContain("微信支付");
    expect(html).toContain("我已完成支付，检查到账");
  });

  it("renders a checkmark animation after the payment order succeeds", () => {
    const html = renderToStaticMarkup(
      React.createElement(PaymentStatusPanel, {
        state: "success",
        payUrl: "https://pay.example/qr",
        method: "alipay",
        order: {
          tradeNo: "yc123",
          userId: "u1",
          amountFen: 10,
          points: 10,
          provider: "epay",
          paymentMethod: "alipay",
          status: "success",
          kind: "points",
          cardId: 0,
          createdAt: "2026-07-02T08:45:36Z",
          paidAt: "2026-07-02T08:45:47Z",
        },
        refreshing: false,
        onClose: () => {},
        onRefresh: () => {},
      }),
    );

    expect(paymentSuccessMessage({
      tradeNo: "yc123",
      userId: "u1",
      amountFen: 10,
      points: 10,
      provider: "epay",
      paymentMethod: "alipay",
      status: "success",
      kind: "points",
      cardId: 0,
      createdAt: "2026-07-02T08:45:36Z",
      paidAt: "2026-07-02T08:45:47Z",
    })).toBe("支付成功，已到账 10 点");
    // 视频点订单文案区分
    expect(paymentSuccessMessage({
      tradeNo: "yc124",
      userId: "u1",
      amountFen: 23400,
      points: 23400,
      provider: "epay",
      paymentMethod: "alipay",
      status: "success",
      kind: "video_points",
      cardId: 0,
      createdAt: "2026-07-02T08:45:36Z",
      paidAt: "2026-07-02T08:45:47Z",
    })).toBe("支付成功，已到账 23,400 视频点");
    expect(html).toContain("payment-success-ring");
    expect(html).toContain("支付成功，已到账 10 点");
  });
});

describe("Billing", () => {
  it("defaults to the membership tab", () => {
    const html = renderToStaticMarkup(createElement(Billing, { token: "token" }));
    expect(html).toContain("会员与充值");
    expect(html).toContain("会员方案");
    expect(html).toContain("合计可用算力点");
  });
});

describe("RechargeTab", () => {
  it("renders separate compute-point and video-point recharge areas", () => {
    const html = renderToStaticMarkup(
      createElement(RechargeTab, {
        detail: null,
        balance: 100,
        videoBalance: 50,
        packages: [],
        rechargeRatio: 100,
        usageRows: [],
        paymentMethod: "alipay",
        loading: false,
        pointCustomYuan: "",
        videoCustomYuan: "",
        customPreviewPoints: 0,
        videoPreviewPoints: 0,
        redeemCode: "",
        setPointCustomYuan: () => {},
        setVideoCustomYuan: () => {},
        setRedeemCode: () => {},
        onTopup: () => {},
        onCustomTopup: () => {},
        onVideoTopup: () => {},
        onRedeem: () => {},
        onLoadUsage: () => {},
        setPaymentMethod: () => {},
      }),
    );
    expect(html).toContain("算力点余额");
    expect(html).toContain("视频点余额");
    expect(html).toContain("算力点快速充值");
    expect(html).toContain("视频点自定义充值");
    expect(html).toContain("1 元 = 100 视频点");
  });
});
