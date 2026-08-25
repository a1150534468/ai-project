import type { PointsDetail, RechargePackage, UsageRow, PaymentMethod } from "../../api";
import { Icon } from "@iconify/react";
import { Stagger, StaggerItem } from "../../motion";
import { QuickRechargePackageCard } from "./QuickRechargePackageCard";
import { usagePointLabel, usageTypeLabel, usageDiscountLabel, paymentMethodLabel } from "../Billing";

interface RechargeTabProps {
  detail: PointsDetail | null;
  balance: number | null;
  videoBalance: number | null;
  packages: RechargePackage[];
  rechargeRatio: number;
  usageRows: UsageRow[];
  paymentMethod: PaymentMethod;
  loading: boolean;
  pointCustomYuan: string;
  videoCustomYuan: string;
  customPreviewPoints: number;
  videoPreviewPoints: number;
  redeemCode: string;
  setPointCustomYuan: (v: string) => void;
  setVideoCustomYuan: (v: string) => void;
  setRedeemCode: (v: string) => void;
  onTopup: (pkg: RechargePackage) => void;
  onCustomTopup: () => void;
  onVideoTopup: () => void;
  onRedeem: () => void;
  onLoadUsage: () => void;
  setPaymentMethod: (m: PaymentMethod) => void;
}

export function RechargeTab(p: RechargeTabProps) {
  const total = p.detail?.totalPoints ?? p.balance;
  const temp = p.detail?.membershipPoints ?? null;
  const video = p.detail?.videoBalance ?? p.videoBalance;
  return (
    <div>
      {/* 精简余额条 */}
      <div className="bg-white rounded-2xl p-4 mb-5 border border-gray-50 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <span className="text-[11px] text-gray-400 font-medium">算力点余额</span>
          <span className="ml-2 text-lg font-extrabold text-ink">{total === null ? "同步中" : total.toLocaleString()}</span>
          {temp !== null && <span className="ml-1 text-[11px] text-gray-400">（含临时 {temp.toLocaleString()}）</span>}
        </div>
        <div>
          <span className="text-[11px] text-gray-400 font-medium">视频点余额</span>
          <span className="ml-2 text-lg font-extrabold text-ink">{video === null ? "同步中" : video.toLocaleString()}</span>
        </div>
        <div className="ml-auto inline-flex rounded-full bg-gray-50 p-1">
          {(["alipay", "wxpay"] as PaymentMethod[]).map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => p.setPaymentMethod(method)}
              disabled={p.loading}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all ${p.paymentMethod === method ? "bg-white text-brand-ink shadow-sm" : "text-gray-500 "}`}
            >
              <Icon icon={p.paymentMethod === method ? (method === "wxpay" ? "ri:wechat-pay-fill" : "ri:alipay-fill") : (method === "wxpay" ? "ri:wechat-pay-fill" : "ri:alipay-fill")} className="text-lg" />
              {paymentMethodLabel(method)}
            </button>
          ))}
        </div>
      </div>

      {/* 快速充值 */}
      <div className="mb-6">
        <h3 className="text-base font-semibold text-ink mb-4">算力点快速充值</h3>
        <Stagger className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
          {p.packages.map((pkg, idx) => (
            <StaggerItem key={pkg.id}>
              <QuickRechargePackageCard pkg={pkg} index={idx} rechargeRatio={p.rechargeRatio} loading={p.loading} onTopup={p.onTopup} />
            </StaggerItem>
          ))}
          {p.packages.length === 0 && (
            <div className="sm:col-span-2 xl:col-span-4 bg-white rounded-2xl p-6 border border-dashed border-gray-200 text-sm text-gray-500">
              后台暂未配置算力点快速充值套餐，可使用下方算力点自定义充值。
            </div>
          )}
        </Stagger>
      </div>

      {/* 自定义充值 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-2xl p-6 border border-gray-50">
          <h3 className="text-base font-semibold text-ink mb-4">算力点自定义充值</h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
              <input type="number" min="0.01" step="0.01" value={p.pointCustomYuan} onChange={(e) => p.setPointCustomYuan(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") p.onCustomTopup(); }} placeholder="输入充值金额"
                className="w-full pl-8 pr-4 py-2.5 border border-gray-200 rounded-full text-sm focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20" disabled={p.loading} />
            </div>
            <button onClick={p.onCustomTopup} disabled={p.loading || !p.pointCustomYuan.trim()} className="px-6 py-2.5 bg-brand text-white text-sm font-medium rounded-full transition-all disabled:opacity-50">{p.loading ? "处理中..." : "生成支付码"}</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-gray-400">当前汇率：1 元 = {p.rechargeRatio.toLocaleString()} 算力点</span>
            <span className="px-2.5 py-1 rounded-full bg-brand-soft text-brand-ink font-medium">预计到账 {p.customPreviewPoints.toLocaleString()} 算力点</span>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-gray-50">
          <h3 className="text-base font-semibold text-ink mb-4">视频点自定义充值</h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
              <input type="number" min="0.01" step="0.01" value={p.videoCustomYuan} onChange={(e) => p.setVideoCustomYuan(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") p.onVideoTopup(); }} placeholder="输入充值金额"
                className="w-full pl-8 pr-4 py-2.5 border border-gray-200 rounded-full text-sm focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20" disabled={p.loading} />
            </div>
            <button onClick={p.onVideoTopup} disabled={p.loading || !p.videoCustomYuan.trim()} className="px-6 py-2.5 bg-brand text-white text-sm font-medium rounded-full transition-all disabled:opacity-50">{p.loading ? "处理中..." : "生成支付码"}</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-gray-400">固定汇率：1 元 = 100 视频点</span>
            <span className="px-2.5 py-1 rounded-full bg-brand-soft text-brand-ink font-medium">预计到账 {p.videoPreviewPoints.toLocaleString()} 视频点</span>
          </div>
        </div>
      </div>

      {/* 兑换码 */}
      <div className="bg-white rounded-2xl p-6 mb-6 border border-gray-50">
        <h3 className="text-base font-semibold text-ink mb-4">兑换码</h3>
        <div className="flex gap-3">
          <input type="text" value={p.redeemCode} onChange={(e) => p.setRedeemCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") p.onRedeem(); }}
            placeholder="请输入兑换码" className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20" disabled={p.loading} />
          <button onClick={p.onRedeem} disabled={p.loading} className="px-6 py-2.5 bg-brand text-white text-sm font-medium rounded-full transition-all disabled:opacity-50">{p.loading ? "处理中..." : "兑换"}</button>
        </div>
      </div>

      {/* 消耗明细 */}
      <div className="bg-white rounded-2xl p-6 border border-gray-50">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-semibold text-ink">算力点消耗</h3>
            <p className="text-xs text-gray-400 mt-1">显示最近 20 条实际结算记录</p>
          </div>
          <button onClick={p.onLoadUsage} className="px-3 py-2 text-xs text-gray-600 bg-gray-50 rounded-full transition-colors">刷新</button>
        </div>
        {p.usageRows.length > 0 ? (
          <Stagger className="space-y-2">
            {p.usageRows.map((row) => (
              <StaggerItem key={row.operationId}>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{usageTypeLabel(row)}</span>
                      {row.type !== "video-script" && row.type !== "dub-rewrite" && <span className="px-2 py-0.5 rounded-full bg-gray-50 text-[10px] text-gray-500">{row.displayName || row.model}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mt-1">{new Date(row.createdAt).toLocaleString()} · {usageDiscountLabel(row)}</p>
                  </div>
                  <div className="text-right flex-none">
                    <p className="text-sm font-bold text-ink">{usagePointLabel(row)}</p>
                    <p className="text-[10px] text-gray-400 mt-1">{row.status === "settled" ? "已结算" : row.status === "reserved" ? "结算中" : row.status}</p>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        ) : (
          <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">暂无消耗记录</div>
        )}
      </div>
    </div>
  );
}
