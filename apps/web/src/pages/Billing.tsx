import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "@iconify/react";
import { formatBalanceLabel, startPaymentBalancePolling } from "../balanceSync";
import {
  topup,
  redeem,
  getBalance,
  getTopupOrder,
  listRechargePackages,
  getRechargeRatio,
  listUsage,
  listMembershipCards,
  buyMembership,
  getVipSummary,
  getPointsDetail,
  type TopupResponse,
  type RechargePackage,
  type UsageRow,
  type VipSummary,
  type PaymentMethod,
  type TopupOrder,
  type PointsDetail,
} from "../api";
import { MemberTab } from "./billing/MemberTab";
import { RechargeTab } from "./billing/RechargeTab";
import { Modal, Confetti } from "../motion";
import { formatVipDiscount } from "./ModelMarketplace";

interface BillingProps {
  token: string;
  onBalanceChange?: (balance: number) => void;
}

export interface MembershipCard {
  id: number;
  name: string;
  priceFen: number;
  durationDays: number;
  cadence: string;
  grantPoints: number;
  kbQuotaBytes?: number;
  enabled: boolean;
}

interface PendingPayment {
  payUrl: string;
  tradeNo: string;
  method: PaymentMethod;
  kind: "points" | "membership" | "video";
}

type PaymentPanelState = "pending" | "success";

export function paymentMethodLabel(method: PaymentMethod): string {
  return method === "wxpay" ? "微信支付" : "支付宝";
}

export function paymentSuccessMessage(order?: TopupOrder | null): string {
  if (!order) return "支付成功";
  if (order.kind === "membership") return "支付成功，会员已生效";
  if (order.kind === "video_points") return `支付成功，已到账 ${order.points.toLocaleString()} 视频点`;
  return `支付成功，已到账 ${order.points.toLocaleString()} 点`;
}

interface PaymentStatusPanelProps {
  state: PaymentPanelState;
  payUrl: string;
  method: PaymentMethod;
  order?: TopupOrder | null;
  refreshing: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export function PaymentStatusPanel({
  state,
  payUrl,
  method,
  order,
  refreshing,
  onClose,
  onRefresh,
}: PaymentStatusPanelProps) {
  const methodLabel = paymentMethodLabel(method);
  const success = state === "success";
  return (
    <div className="bg-white rounded-2xl p-6 border border-gray-50 text-center w-full max-w-sm shadow-[0_24px_60px_rgba(15,23,42,0.18)]">
      <h3 className="text-base font-semibold text-ink mb-4">{success ? "支付成功" : "扫码支付"}</h3>
      <div className="flex justify-center mb-4">
        {success ? (
          <div className="payment-success-ring flex h-32 w-32 items-center justify-center rounded-full bg-brand-soft text-brand-ink">
            <span className="payment-success-check block h-14 w-7 border-b-[6px] border-r-[6px] border-brand" aria-hidden />
          </div>
        ) : (
          <QRCodeSVG value={payUrl} size={256} level="H" includeMargin={true} />
        )}
      </div>
      <p className="text-sm text-gray-600 mb-4">
        {success ? paymentSuccessMessage(order) : `请使用${methodLabel}扫描二维码完成支付`}
      </p>
      <button
        onClick={onClose}
        className="px-6 py-2 bg-gray-50 text-gray-600 text-sm font-medium rounded-full transition-all"
      >
        {success ? "知道了" : "关闭二维码"}
      </button>
      {!success && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-3 px-6 py-2 bg-brand text-white text-sm font-medium rounded-full transition-all disabled:opacity-60"
        >
          {refreshing ? "检查中..." : "我已完成支付，检查到账"}
        </button>
      )}
    </div>
  );
}

export function usagePointLabel(row: UsageRow): string {
  const unit = usagePointUnit(row);
  if (row.status === "reserved") return `结算中`;
  if (row.status === "refunded") return `0 ${unit}`; // 已退款，净实扣为 0
  if (row.actualPoints <= 0) return `0 ${unit}`;
  return `-${row.actualPoints.toLocaleString()} ${unit}`;
}

function usagePointUnit(row: UsageRow): string {
  return row.type === "video" ? "视频点" : "点";
}

export function usageTypeLabel(row: UsageRow): string {
  if (row.type === "chat") return "对话";
  if (row.type === "video") return "AI 视频";
  if (row.type === "video-script") return "脚本生成扣费";
  if (row.type === "dub-rewrite") return "洗稿文案扣费";
  if (row.type === "report") return "报告生成";
  return row.type;
}

function formatVideoBalanceLabel(balance: number | null): string {
  if (balance === null) return "同步中";
  return `${balance.toLocaleString()} 视频点`;
}

export function usageDiscountLabel(row: UsageRow): string {
  if (row.status === "reserved") return "结算后展示实扣";
  const actualPoints = row.status === "refunded" ? 0 : row.actualPoints; // 已退款净实扣为 0
  const originalPoints = row.originalPoints ?? actualPoints;
  const discountBps = row.vipDiscountBps ?? 10000;
  const levelName = row.vipLevelName || "普通会员";
  const pieces = [`原扣 ${originalPoints.toLocaleString()} 点`, `实扣 ${actualPoints.toLocaleString()} 点`];
  if (discountBps < 10000) pieces.unshift(`${levelName} ${formatVipDiscount(discountBps)}`);
  return pieces.join(" · ");
}

export default function Billing({ token, onBalanceChange }: BillingProps) {
  const [balance, setBalance] = useState<number | null>(null);
  const [videoBalance, setVideoBalance] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("alipay");
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentPanelState>("pending");
  const [paymentOrder, setPaymentOrder] = useState<TopupOrder | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [pointCustomYuan, setPointCustomYuan] = useState("");
  const [videoCustomYuan, setVideoCustomYuan] = useState("");
  const [rechargeRatio, setRechargeRatio] = useState(100);
  const [packages, setPackages] = useState<RechargePackage[]>([]);
  const [membershipCards, setMembershipCards] = useState<MembershipCard[]>([]);
  const [vipSummary, setVipSummary] = useState<VipSummary | null>(null);
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshingPayment, setRefreshingPayment] = useState(false);
  const [activeTab, setActiveTab] = useState<"member" | "recharge">("member");
  const [pointsDetail, setPointsDetail] = useState<PointsDetail | null>(null);

  const customAmountFen = Math.round(Number(pointCustomYuan) * 100);
  const customPreviewPoints = Number.isFinite(customAmountFen) && customAmountFen > 0
    ? Math.floor((customAmountFen * rechargeRatio) / 100)
    : 0;
  const videoAmountFen = Math.round(Number(videoCustomYuan) * 100);
  const videoPreviewPoints = Number.isFinite(videoAmountFen) && videoAmountFen > 0
    ? Math.floor(videoAmountFen)
    : 0;

  const handleRefreshBalance = useCallback(async () => {
    try {
      const result = await getBalance(token);
      setBalance(result.balance);
      setVideoBalance(result.videoBalance ?? 0);
      onBalanceChange?.(result.balance);
    } catch (err) {
      setMessage(`刷新失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }, [onBalanceChange, token]);

  const handleLoadVipSummary = useCallback(async () => {
    try {
      setVipSummary(await getVipSummary(token));
    } catch {
      setVipSummary(null);
    }
  }, [token]);

  const handleLoadPointsDetail = useCallback(async () => {
    try {
      setPointsDetail(await getPointsDetail(token));
    } catch {
      setPointsDetail(null); // 降级：卡片回退到合计余额
    }
  }, [token]);

  const handleLoadPackages = useCallback(async () => {
    try {
      const [packagesResult, ratioResult, cardsResult] = await Promise.allSettled([
        listRechargePackages(token),
        getRechargeRatio(token),
        listMembershipCards(token),
      ]);
      if (packagesResult.status === "fulfilled") setPackages(packagesResult.value.filter((pkg) => pkg.enabled));
      if (ratioResult.status === "fulfilled") setRechargeRatio(ratioResult.value);
      if (cardsResult.status === "fulfilled") setMembershipCards(cardsResult.value.filter((card) => card.enabled));
      const firstError = packagesResult.status === "rejected" ? packagesResult.reason : ratioResult.status === "rejected" ? ratioResult.reason : cardsResult.status === "rejected" ? cardsResult.reason : null;
      if (firstError) setMessage(`套餐加载失败: ${firstError instanceof Error ? firstError.message : "未知错误"}`);
    } catch (err) {
      setMessage(`套餐加载失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }, [token]);

  const handleLoadUsage = useCallback(async () => {
    try {
      setUsageRows(await listUsage(token, 20));
    } catch (err) {
      setMessage(`消耗明细加载失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }, [token]);

  const refreshAccountSnapshot = useCallback(async () => {
    await Promise.all([handleRefreshBalance(), handleLoadUsage()]);
  }, [handleLoadUsage, handleRefreshBalance]);

  const closePaymentPanel = useCallback(() => {
    setPendingPayment(null);
    setPaymentOrder(null);
    setPaymentState("pending");
  }, []);

  const checkPendingPayment = useCallback(async (options?: { silent?: boolean }) => {
    if (!pendingPayment) return;
    try {
      if (!options?.silent) setRefreshingPayment(true);
      const order = await getTopupOrder(token, pendingPayment.tradeNo);
      if (order.status === "success") {
        setPaymentOrder(order);
        setPaymentState("success");
        await Promise.all([refreshAccountSnapshot(), handleLoadVipSummary(), handleLoadPointsDetail()]);
        setMessage(paymentSuccessMessage(order));
        return;
      }
      await refreshAccountSnapshot();
      if (!options?.silent) setMessage("还没有收到支付结果，请稍后再试");
    } catch (err) {
      if (!options?.silent) {
        setMessage(`支付状态刷新失败: ${err instanceof Error ? err.message : "未知错误"}`);
      }
    } finally {
      if (!options?.silent) setRefreshingPayment(false);
    }
  }, [handleLoadVipSummary, handleLoadPointsDetail, pendingPayment, refreshAccountSnapshot, token]);

  useEffect(() => {
    void handleRefreshBalance();
    void handleLoadPackages();
    void handleLoadVipSummary();
    void handleLoadUsage();
    void handleLoadPointsDetail();
  }, [handleLoadPackages, handleLoadUsage, handleLoadVipSummary, handleRefreshBalance, handleLoadPointsDetail]);

  useEffect(() => {
    if (!pendingPayment || paymentState === "success") return;
    const stopPolling = startPaymentBalancePolling({
      refresh: () => checkPendingPayment({ silent: true }),
    });
    const refresh = () => {
      void checkPendingPayment({ silent: true });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      stopPolling();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [checkPendingPayment, paymentState, pendingPayment]);

  const handleTopup = async (pkg: RechargePackage) => {
    try {
      setMessage("");
      setLoading(true);
      const result: TopupResponse = await topup(token, { packageId: pkg.id, method: paymentMethod });
      setPaymentOrder(null);
      setPaymentState("pending");
      setPendingPayment({ payUrl: result.payUrl, tradeNo: result.tradeNo, method: paymentMethod, kind: "points" });
      await handleLoadUsage();
    } catch (err) {
      setMessage(`充值失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCustomTopup = async () => {
    const yuan = Number(pointCustomYuan);
    const amountFen = Math.round(yuan * 100);
    if (!Number.isFinite(yuan) || amountFen <= 0) {
      setMessage("请输入有效的充值金额");
      return;
    }
    try {
      setMessage("");
      setLoading(true);
      const result: TopupResponse = await topup(token, { amountFen, method: paymentMethod });
      setPaymentOrder(null);
      setPaymentState("pending");
      setPendingPayment({ payUrl: result.payUrl, tradeNo: result.tradeNo, method: paymentMethod, kind: "points" });
      await handleLoadUsage();
    } catch (err) {
      setMessage(`充值失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleVideoTopup = async () => {
    const yuan = Number(videoCustomYuan);
    const amountFen = Math.round(yuan * 100);
    if (!Number.isFinite(yuan) || amountFen <= 0) {
      setMessage("请输入有效的视频点充值金额");
      return;
    }
    try {
      setMessage("");
      setLoading(true);
      const result: TopupResponse = await topup(token, { amountFen, method: paymentMethod, accountType: "video" });
      setPaymentOrder(null);
      setPaymentState("pending");
      setPendingPayment({ payUrl: result.payUrl, tradeNo: result.tradeNo, method: paymentMethod, kind: "video" });
      await handleLoadUsage();
    } catch (err) {
      setMessage(`视频点充值失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleBuyMembership = async (card: MembershipCard) => {
    try {
      setMessage("");
      setLoading(true);
      const result = await buyMembership(token, card.id, paymentMethod);
      setPaymentOrder(null);
      setPaymentState("pending");
      setPendingPayment({ payUrl: result.payUrl, tradeNo: result.tradeNo, method: paymentMethod, kind: "membership" });
      setMessage(`请使用${paymentMethodLabel(paymentMethod)}完成会员支付`);
      await handleLoadUsage();
    } catch (err) {
      setMessage(`会员购买失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRedeem = async () => {
    try {
      setMessage("");
      if (!redeemCode.trim()) {
        setMessage("请输入兑换码");
        return;
      }
      setLoading(true);
      await redeem(token, redeemCode);
      setRedeemCode("");
      await handleRefreshBalance();
      await handleLoadUsage();
      setMessage("兑换成功");
    } catch (err) {
      setMessage(`兑换失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-surface-muted">
      <div className="max-w-5xl mx-auto p-6">
        {/* 标题 + Tab */}
        <div className="mb-5">
          <h1 className="text-[28px] font-bold text-ink tracking-tight">会员与充值</h1>
          <div className="flex items-center gap-7 border-b border-gray-100 pb-2.5 mt-4">
            {(["member", "recharge"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`relative pb-1 text-base font-semibold transition-colors ${activeTab === t ? "text-ink" : "text-gray-400 "}`}
              >
                {t === "member" ? "会员" : "积分充值"}
                {activeTab === t && <span className="absolute left-0 right-0 -bottom-[11px] h-0.5 rounded bg-brand" />}
              </button>
            ))}
          </div>
        </div>

        {/* 支付弹窗（共享） */}
        <Modal open={Boolean(pendingPayment)} onClose={closePaymentPanel}>
          {pendingPayment && (
            <PaymentStatusPanel
              state={paymentState}
              payUrl={pendingPayment.payUrl}
              method={pendingPayment.method}
              order={paymentOrder}
              refreshing={refreshingPayment}
              onClose={closePaymentPanel}
              onRefresh={() => {
                void checkPendingPayment();
              }}
            />
          )}
        </Modal>
        {pendingPayment && <Confetti trigger={paymentState === "success"} />}

        {activeTab === "member" ? (
          <MemberTab
            detail={pointsDetail}
            balance={balance}
            videoBalance={videoBalance}
            vip={vipSummary}
            membershipCards={membershipCards}
            loading={loading}
            onBuyMembership={handleBuyMembership}
            onGotoUsage={() => setActiveTab("recharge")}
          />
        ) : (
          <RechargeTab
            detail={pointsDetail}
            balance={balance}
            videoBalance={videoBalance}
            packages={packages}
            rechargeRatio={rechargeRatio}
            usageRows={usageRows}
            paymentMethod={paymentMethod}
            loading={loading}
            pointCustomYuan={pointCustomYuan}
            videoCustomYuan={videoCustomYuan}
            customPreviewPoints={customPreviewPoints}
            videoPreviewPoints={videoPreviewPoints}
            redeemCode={redeemCode}
            setPointCustomYuan={setPointCustomYuan}
            setVideoCustomYuan={setVideoCustomYuan}
            setRedeemCode={setRedeemCode}
            onTopup={handleTopup}
            onCustomTopup={handleCustomTopup}
            onVideoTopup={handleVideoTopup}
            onRedeem={handleRedeem}
            onLoadUsage={handleLoadUsage}
            setPaymentMethod={setPaymentMethod}
          />
        )}

        {/* 消息提示 */}
        {message && (
          <div
            className={`rounded-2xl p-4 border ${
              message.includes("失败") || message.includes("错误")
                ? "bg-red-50 border-red-200 text-red-700"
                : "bg-brand-soft border-brand/30 text-brand-ink"
            }`}
          >
            <div className="flex items-start gap-3">
              <Icon
                icon={message.includes("失败") || message.includes("错误") ? "mdi:alert-circle" : "mdi:check-circle"}
                className="text-xl flex-none mt-0.5"
              />
              <p className="text-sm">{message}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
