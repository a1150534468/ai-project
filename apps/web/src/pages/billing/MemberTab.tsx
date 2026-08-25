import type { PointsDetail, VipSummary } from "../../api";
import type { MembershipCard } from "../Billing";
import { Stagger, StaggerItem } from "../../motion";
import { CurrentPlanCard } from "./CurrentPlanCard";
import { cadenceLabel, totalGrantOverDuration } from "./planMath";

interface MemberTabProps {
  detail: PointsDetail | null;
  balance: number | null;
  videoBalance: number | null;
  vip: VipSummary | null;
  membershipCards: MembershipCard[];
  loading: boolean;
  onBuyMembership: (card: MembershipCard) => void;
  onGotoUsage: () => void;
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB 知识库`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2).toLocaleString()} MB 知识库`;
  return `${Math.round(bytes / 1024).toLocaleString()} KB 知识库`;
}

export function MemberTab({ detail, balance, videoBalance, vip, membershipCards, loading, onBuyMembership, onGotoUsage }: MemberTabProps) {
  const currentCardName = detail?.membership?.cardName ?? null;
  const gotoPlans = () => document.getElementById("member-plans")?.scrollIntoView({ behavior: "smooth" });
  return (
    <div>
      <CurrentPlanCard detail={detail} balance={balance} videoBalance={videoBalance} vip={vip} onGotoUsage={onGotoUsage} onGotoPlans={gotoPlans} />

      <div id="member-plans" className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-ink">会员方案</h3>
        <span className="text-xs text-gray-400">一次性购买 · 到期不自动续费</span>
      </div>
      {membershipCards.length > 0 ? (
        <Stagger className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {membershipCards.map((card) => {
            const label = cadenceLabel(card.cadence);
            const total = totalGrantOverDuration(card.cadence, card.durationDays, card.grantPoints);
            const quota = formatBytes(card.kbQuotaBytes);
            const isCurrent = currentCardName != null && card.name === currentCardName;
            return (
              <StaggerItem key={card.id}>
                <div className={`bg-white rounded-2xl p-5 border relative ${isCurrent ? "border-brand ring-2 ring-brand" : "border-gray-50"}`}>
                  {isCurrent && <span className="absolute top-4 right-4 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-brand-soft text-brand-ink">当前</span>}
                  <p className="text-sm font-semibold text-ink">{card.name}</p>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-2xl font-extrabold text-ink">¥{(card.priceFen / 100).toFixed(0)}</span>
                    <span className="text-xs text-gray-400">/ 有效期 {card.durationDays} 天</span>
                  </div>
                  <div className="mt-4 rounded-xl bg-brand-soft p-3">
                    <p className="text-[11px] text-brand-ink font-semibold">{label}发放</p>
                    <p className="text-xl font-extrabold text-brand-ink mt-0.5">{card.grantPoints.toLocaleString()} <span className="text-xs font-semibold">算力点</span></p>
                    <p className="text-[11px] text-gray-500 mt-1">{label}刷新 · 到期未用清零</p>
                  </div>
                  <p className="text-[12px] text-gray-400 mt-3">整个周期共发放 <b className="text-ink">{total.approx ? "约 " : ""}{total.points.toLocaleString()}</b> 点</p>
                  {quota && <p className="text-[12px] text-gray-400 mt-1">{quota}</p>}
                  <button
                    onClick={() => onBuyMembership(card)}
                    disabled={loading}
                    className={`w-full mt-4 py-2.5 text-[13px] font-medium rounded-full transition-all disabled:opacity-50 ${isCurrent ? "bg-gray-50 text-gray-600 " : "bg-brand text-white "}`}
                  >
                    {loading ? "处理中..." : isCurrent ? "再次购买" : "购买会员"}
                  </button>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">暂无可购买会员</div>
      )}
    </div>
  );
}
