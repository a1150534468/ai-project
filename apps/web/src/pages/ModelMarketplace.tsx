import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import {
  listModelMarketplace,
  type ModelMarketplacePrice,
  type ModelMarketplaceRow,
  type VipSummary,
} from "../api";

interface ModelMarketplaceProps {
  token: string;
}

export function formatVipDiscount(discountBps?: number | null): string {
  if (!discountBps || discountBps >= 10000) return "无折扣";
  return `${Number((discountBps / 1000).toFixed(1))} 折`;
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : Number(value.toFixed(4)).toLocaleString();
}

function sortedRows(rows: ModelMarketplaceRow[]): ModelMarketplaceRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
}

export default function ModelMarketplace({ token }: ModelMarketplaceProps) {
  const [models, setModels] = useState<ModelMarketplaceRow[]>([]);
  const [vip, setVip] = useState<VipSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage("");
    listModelMarketplace(token)
      .then((result) => {
        if (cancelled) return;
        setModels(sortedRows(result.data.filter((row) => row.showInMarketplace && row.enabled)));
        setVip(result.vip);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "模型广场加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex-1 overflow-auto bg-[#f5f7fa]">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight text-[#1d1d1f]">模型广场</h1>
            <p className="mt-1 text-sm text-gray-500">查看当前账号可用模型、适用场景和每百万 token 计价</p>
          </div>
          <VipSummaryBadge vip={vip} />
        </div>

        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#1d1d1f]">全部模型</h2>
            <p className="mt-1 text-xs text-gray-400">{models.length} 个模型可用</p>
          </div>
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-gray-400">
              <Icon icon="mdi:loading" className="animate-spin text-sm" aria-hidden />
              加载中
            </span>
          )}
        </div>

        {message && (
          <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            {message}
          </div>
        )}

        {models.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {models.map((model) => (
              <ModelCard key={model.model} model={model} />
            ))}
          </div>
        ) : !loading && !message ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
            暂无可用模型
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VipSummaryBadge({ vip }: { vip: VipSummary | null }) {
  const nextProgress = vip && !vip.highestLevel && vip.nextThreshold > 0
    ? Math.min(100, Math.round((vip.growthPoints / vip.nextThreshold) * 100))
    : 100;

  return (
    <div className="w-full rounded-2xl border border-brand/10 bg-white p-4 shadow-sm lg:w-[360px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
            <Icon icon="mdi:diamond-stone" className="text-xl" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#1d1d1f]">{vip?.levelName ?? "VIP 信息同步中"}</p>
            <p className="mt-0.5 text-xs text-gray-400">当前消费折扣：{formatVipDiscount(vip?.discountBps)}</p>
          </div>
        </div>
        <span className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white">
          {formatVipDiscount(vip?.discountBps)}
        </span>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-[11px] text-gray-400">
          <span>{vip?.growthPoints.toLocaleString() ?? "0"} 成长点</span>
          <span>{vip?.highestLevel ? "已满级" : `距 ${vip?.nextLevelName ?? "下一级"} ${vip?.pointsToNextLevel.toLocaleString() ?? "-"}`}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-brand" style={{ width: `${nextProgress}%` }} />
        </div>
      </div>
    </div>
  );
}

export function ModelCard({ model }: { model: ModelMarketplaceRow }) {
  const tags = model.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  const openAIOnly = tags.includes("openai-only");
  const tagLabels: Record<string, string> = {
    "free-quota": "免费额度",
    chat: "对话",
    coding: "编程",
    reasoning: "推理",
    vision: "视觉",
    "tool-use": "工具调用",
    preview: "预览版",
    versioned: "固定版本",
    ocr: "OCR",
    document: "文档",
  };
  const visibleTags = tags
    .filter((tag) => tagLabels[tag])
    .sort((a, b) => Number(b === "free-quota") - Number(a === "free-quota"))
    .slice(0, 5);
  return (
    <article className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-[#1d1d1f]">{model.displayName || "未命名模型"}</h3>
        </div>
        <span className={`inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
          openAIOnly ? "bg-amber-50 text-amber-700" : "bg-brand-soft text-brand-ink"
        }`}>
          <Icon icon={openAIOnly ? "mdi:api" : "mdi:check-circle-outline"} className="text-sm" aria-hidden />
          {openAIOnly ? "仅 OpenAI 接口" : "对话可用"}
        </span>
      </div>

      {visibleTags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
              {tagLabels[tag]}
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 min-h-10 text-sm leading-5 text-gray-600">
        {model.description || "该模型暂未配置介绍"}
      </p>

      <div className="mt-4 rounded-xl bg-gray-50 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-gray-400">
          <Icon icon="mdi:target" className="text-sm" aria-hidden />
          适用场景
        </div>
        <p className="truncate font-medium text-gray-700">{model.useCases || "通用"}</p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PriceBlock title="输入" price={model.vipInputPrice} />
        <PriceBlock title="输出" price={model.vipOutputPrice} />
        <PriceBlock title="缓存创建" price={model.vipCacheInputPrice} muted />
        <PriceBlock title="缓存读取" price={model.vipCacheOutputPrice} muted />
      </div>
    </article>
  );
}

function PriceBlock({ title, price, muted = false }: { title: string; price: ModelMarketplacePrice; muted?: boolean }) {
  const discounted = price.discounted;
  const hasDiscount = discounted < Math.ceil(price.original);
  return (
    <div className={`rounded-xl border px-3 py-3 ${muted ? "border-gray-100 bg-gray-50/50" : "border-brand/10 bg-brand-soft/40"}`}>
      <p className="text-[11px] font-medium text-gray-500">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-bold text-[#1d1d1f]">{formatPoints(discounted)}</span>
        <span className="text-[10px] text-gray-400">点 / 100W token</span>
      </div>
      <p className="mt-1 text-[10px] text-gray-400">
        {hasDiscount ? <>原价 <span className="line-through">{formatPoints(price.original)}</span> 点</> : <>原价 {formatPoints(price.original)} 点</>}
      </p>
    </div>
  );
}
