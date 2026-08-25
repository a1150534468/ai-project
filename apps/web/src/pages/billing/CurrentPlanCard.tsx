import type { PointsDetail, VipSummary } from "../../api";
import { AnimatedNumber } from "../../motion";
import { formatVipDiscount } from "../ModelMarketplace";
import { cadenceLabel } from "./planMath";

interface CurrentPlanCardProps {
  detail: PointsDetail | null;
  balance: number | null;
  videoBalance: number | null;
  vip: VipSummary | null;
  onGotoUsage: () => void;
  onGotoPlans: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function CurrentPlanCard({ detail, balance, videoBalance, vip, onGotoUsage, onGotoPlans }: CurrentPlanCardProps) {
  const total = detail?.totalPoints ?? balance ?? null;
  const video = detail?.videoBalance ?? videoBalance ?? null;
  const period = detail?.currentPeriod ?? null;
  const membership = detail?.membership ?? null;
  const usedPct = period && period.granted > 0 ? Math.min(100, Math.round((period.used / period.granted) * 100)) : 0;

  return (
    <div className="bg-surface rounded-2xl p-5 border border-hairline-subtle mb-6">
      <div className="flex flex-col lg:flex-row gap-5">
        {/* 品牌块 */}
        <div className="rounded-2xl bg-surface-inverse p-5 text-ink-inverse flex-none w-full lg:w-[260px]">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-ink-inverse/15">
            ● {membership ? "生效中" : "未开通"}
          </span>
          <div className="mt-6 text-xl font-bold">{membership?.cardName || "普通会员"}</div>
          {membership ? (
            <>
              <div className="mt-1 text-[12px] text-ink-inverse/70">买断到期 {formatDate(membership.expiresAt)}</div>
              <div className="mt-4 text-[12px] text-ink-inverse/60">{cadenceLabel(membership.cadence)}刷新临时点 · 到期清零</div>
            </>
          ) : (
            <div className="mt-4 text-[12px] text-ink-inverse/60">购买会员可获得每期临时算力点</div>
          )}
        </div>

        {/* 积分区 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] text-ink-tertiary font-medium">合计可用算力点</p>
              <p className="text-[34px] leading-none font-extrabold text-ink mt-1">
                {total === null ? "同步中" : <><AnimatedNumber value={total} /> <span className="text-base font-semibold text-ink-tertiary">点</span></>}
              </p>
            </div>
            <div className="flex gap-2 flex-none">
              <button onClick={onGotoUsage} className="px-4 py-2 text-[13px] font-medium rounded-full bg-surface-subtle text-ink-secondary transition-all">消耗明细</button>
              <button onClick={onGotoPlans} className="px-4 py-2 text-[13px] font-medium rounded-full bg-brand text-white transition-all">购买 / 升级会员</button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
            {/* 临时（套餐） */}
            <div className="rounded-xl border p-3" style={{ borderColor: "#cbeee8", background: "#f5fbfa" }}>
              <p className="text-[11px] text-ink-secondary font-medium flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-brand" />临时算力点 · 套餐</p>
              <p className="text-xl font-bold text-ink mt-1">
                {detail ? detail.membershipPoints.toLocaleString() : "—"} <span className="text-[11px] text-ink-tertiary font-medium">剩余</span>
              </p>
              {period ? (
                <>
                  <div className="mt-2 h-1.5 rounded-full bg-hairline-subtle overflow-hidden"><div className="h-full bg-brand rounded-full" style={{ width: `${100 - usedPct}%` }} /></div>
                  <p className="text-[11px] text-ink-secondary mt-1.5">本期发放 {period.granted.toLocaleString()} · 已用 {period.used.toLocaleString()}</p>
                  <p className="text-[11px] text-warning mt-0.5">{formatDate(period.expiresAt)} 到期清零</p>
                </>
              ) : (
                <p className="text-[11px] text-ink-tertiary mt-2">暂无套餐临时点</p>
              )}
            </div>
            {/* 永久（充值） */}
            <div className="rounded-xl border border-hairline-subtle bg-surface-subtle p-3">
              <p className="text-[11px] text-ink-secondary font-medium flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-ink-tertiary" />永久算力点 · 充值</p>
              <p className="text-xl font-bold text-ink mt-1">{detail ? detail.permanentPoints.toLocaleString() : (total?.toLocaleString() ?? "—")}</p>
              <p className="text-[11px] text-ink-secondary mt-2">永不过期</p>
              <p className="text-[11px] text-ink-tertiary mt-0.5">扣费时临时点优先、永久点保底</p>
            </div>
            {/* 视频点 / VIP */}
            <div className="rounded-xl border border-hairline-subtle bg-surface-subtle p-3">
              <p className="text-[11px] text-ink-secondary font-medium flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-warning" />视频点 · 会员</p>
              <p className="text-xl font-bold text-ink mt-1">{video === null ? "同步中" : video.toLocaleString()}</p>
              <p className="text-[11px] text-ink-secondary mt-2">{vip?.levelName ?? "普通会员"}</p>
              <p className="text-[11px] text-brand-ink mt-0.5">消费 {formatVipDiscount(vip?.discountBps)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
