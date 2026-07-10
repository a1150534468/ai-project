import type { RechargePackage } from "../../api";

interface QuickRechargePackageCardProps {
  readonly pkg: RechargePackage;
  readonly index: number;
  readonly rechargeRatio: number;
  readonly loading: boolean;
  readonly onTopup: (pkg: RechargePackage) => void;
}

export function calculateRechargePackageBonus(amountFen: number, points: number, ratio: number): number {
  if (amountFen <= 0 || points <= 0 || ratio <= 0) return 0;
  const basePoints = Math.floor((amountFen * ratio) / 100);
  return Math.max(points - basePoints, 0);
}

export function QuickRechargePackageCard({
  pkg,
  index,
  rechargeRatio,
  loading,
  onTopup,
}: QuickRechargePackageCardProps) {
  const recommended = index === 1;
  const bonusPoints = calculateRechargePackageBonus(pkg.amountFen, pkg.points, rechargeRatio);

  return (
    <div
      className={`bg-white rounded-2xl p-5 border transition-all cursor-pointer ${
        recommended ? "border-brand border-2 shadow-sm relative" : "border-gray-50 hover:border-brand/30 hover:shadow-sm"
      }`}
    >
      {recommended && (
        <span className="absolute -top-2.5 right-4 px-2.5 py-0.5 bg-brand text-white text-[9px] font-medium rounded-full">
          推荐
        </span>
      )}
      <p className="text-xs font-medium text-gray-500 mb-2 truncate">{pkg.name}</p>
      <p className="text-2xl font-bold text-[#1d1d1f]">{pkg.points.toLocaleString()}</p>
      <p className="text-[11px] text-gray-400 mt-0.5">算力点</p>
      {bonusPoints > 0 && (
        <p className="mt-2 inline-flex rounded-full bg-red-50 px-2.5 py-1 text-[10px] font-semibold text-red-600 ring-1 ring-red-100">
          活动赠送 {bonusPoints.toLocaleString()} 点
        </p>
      )}
      <p className="text-lg font-semibold text-[#1d1d1f] mt-3">¥{(pkg.amountFen / 100).toFixed(2)}</p>
      <p className={`text-[10px] mt-0.5 ${recommended ? "text-brand-ink" : "text-gray-400"}`}>
        约 {(pkg.amountFen / 100 / pkg.points).toFixed(4)} 元/点
      </p>
      <button
        type="button"
        onClick={() => onTopup(pkg)}
        disabled={loading}
        className={`w-full mt-3 py-2 text-xs font-medium rounded-full transition-all ${
          recommended
            ? "bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
            : "bg-gray-50 text-gray-600 hover:bg-brand hover:text-white disabled:opacity-50"
        }`}
      >
        {loading ? "处理中..." : "立即购买"}
      </button>
    </div>
  );
}
