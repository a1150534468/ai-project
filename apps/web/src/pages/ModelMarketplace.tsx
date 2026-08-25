import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import {
  listModelMarketplace,
  type ModelMarketplaceImagePrice,
  type ModelMarketplacePrice,
  type ModelMarketplaceRow,
  type VipSummary,
} from "../api";

const CATEGORY_ORDER = ["语言模型", "语音模型", "视觉模型", "向量模型"] as const;

const CATEGORY_ICON: Record<string, string> = {
  语言模型: "mdi:translate",
  语音模型: "mdi:waveform",
  视觉模型: "mdi:image-multiple",
  向量模型: "mdi:vector-polyline",
};

interface ModelGroup {
  category: string;
  rows: ModelMarketplaceRow[];
}

export function groupByCategory(rows: ModelMarketplaceRow[]): ModelGroup[] {
  const map = new Map<string, ModelMarketplaceRow[]>();
  for (const row of rows) {
    const key = row.category || "其他模型";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  const groups: ModelGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = map.get(category);
    if (items) {
      groups.push({ category, rows: sortedRows(items) });
      map.delete(category);
    }
  }
  const remaining = [...map.keys()].sort((a, b) => a.localeCompare(b));
  for (const category of remaining) {
    groups.push({ category, rows: sortedRows(map.get(category)!) });
  }
  return groups;
}

/** Pure filter used by the top tab bar: "全部" shows every group, a specific
 *  category narrows the view to that single group. */
export function selectVisibleGroups(groups: ModelGroup[], activeCategory: string): ModelGroup[] {
  return activeCategory === "全部"
    ? groups
    : groups.filter((group) => group.category === activeCategory);
}

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
  const [activeCategory, setActiveCategory] = useState("全部");

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

  const groups = groupByCategory(models);
  const tabs = ["全部", ...groups.map((group) => group.category)];
  const visibleGroups = selectVisibleGroups(groups, activeCategory);

  return (
    <div className="flex-1 overflow-auto bg-surface-muted">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight text-ink">模型广场</h1>
            <p className="mt-1 text-sm text-ink-secondary">查看当前账号可用模型、适用场景与计价（按类型分组展示）</p>
          </div>
          <VipSummaryBadge vip={vip} />
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-tertiary">{models.length} 个模型可用 · {groups.length} 个分类</p>
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-ink-tertiary">
              <Icon icon="mdi:loading" className="animate-spin text-sm" aria-hidden />
              加载中
            </span>
          )}
        </div>

        <div className="sticky top-0 z-10 -mx-2 mb-6 flex gap-2 overflow-x-auto px-2 pb-2">
          {tabs.map((tab) => {
            const isActive = tab === activeCategory;
            const count = tab === "全部"
              ? models.length
              : (groups.find((group) => group.category === tab)?.rows.length ?? 0);
            const icon = tab === "全部" ? "mdi:apps" : (CATEGORY_ICON[tab] ?? "mdi:shape-outline");
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveCategory(tab)}
                className={`inline-flex flex-none items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "border-brand bg-brand text-white shadow-sm"
                    : "border-hairline-subtle bg-surface text-ink-secondary hover:border-brand/40 hover:text-brand-ink"
                }`}
              >
                <Icon icon={icon} className="text-base" aria-hidden />
                {tab}
                <span className={`ml-0.5 rounded-full px-1.5 text-[11px] ${
                  isActive ? "bg-white/20 text-white" : "bg-surface-muted text-ink-secondary"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>

        {message && (
          <div className="mb-4 rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger-ink">
            {message}
          </div>
        )}

        {visibleGroups.length > 0 ? (
          visibleGroups.map((group) => (
            <section key={group.category} className="mb-8">
              {activeCategory === "全部" && (
                <div className="mb-4 flex items-center gap-2">
                  <Icon icon={CATEGORY_ICON[group.category] ?? "mdi:shape-outline"} className="text-lg text-brand" aria-hidden />
                  <h2 className="text-base font-semibold text-ink">{group.category}</h2>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{group.rows.length}</span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {group.rows.map((model) => (
                  <ModelCard key={model.model} model={model} />
                ))}
              </div>
            </section>
          ))
        ) : !loading && !message ? (
          <div className="rounded-xl border border-dashed border-hairline-subtle bg-surface p-8 text-center text-sm text-ink-tertiary">
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
    <div className="w-full rounded-2xl border border-brand/10 bg-surface p-4 shadow-sm lg:w-[360px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
            <Icon icon="mdi:diamond-stone" className="text-xl" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{vip?.levelName ?? "VIP 信息同步中"}</p>
            <p className="mt-0.5 text-xs text-ink-tertiary">当前消费折扣：{formatVipDiscount(vip?.discountBps)}</p>
          </div>
        </div>
        <span className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white">
          {formatVipDiscount(vip?.discountBps)}
        </span>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-[11px] text-ink-tertiary">
          <span>{vip?.growthPoints.toLocaleString() ?? "0"} 成长点</span>
          <span>{vip?.highestLevel ? "已满级" : `距 ${vip?.nextLevelName ?? "下一级"} ${vip?.pointsToNextLevel.toLocaleString() ?? "-"}`}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-brand" style={{ width: `${nextProgress}%` }} />
        </div>
      </div>
    </div>
  );
}

export function ModelCard({ model }: { model: ModelMarketplaceRow }) {
  const tags = model.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  const openAIOnly = tags.includes("openai-only");
  const isImage = Boolean(model.imagePrice);
  const tagLabels: Record<string, string> = {
    "free-quota": "免费额度",
    chat: "对话",
    coding: "编程",
    reasoning: "推理",
    vision: "视觉",
    "image-gen": "生图",
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
    <article className="rounded-2xl border border-hairline-subtle bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{model.displayName || "未命名模型"}</h3>
        </div>
        <span className={`inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
          openAIOnly ? "bg-warning/10 text-warning-ink" : "bg-brand-soft text-brand-ink"
        }`}>
          <Icon icon={isImage ? "mdi:image-outline" : openAIOnly ? "mdi:api" : "mdi:check-circle-outline"} className="text-sm" aria-hidden />
          {isImage ? "生图可用" : openAIOnly ? "仅 OpenAI 接口" : "对话可用"}
        </span>
      </div>

      {visibleTags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <span key={tag} className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
              {tagLabels[tag]}
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 min-h-10 text-sm leading-5 text-ink-secondary">
        {model.description || "该模型暂未配置介绍"}
      </p>

      <div className="mt-4 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
          <Icon icon="mdi:target" className="text-sm" aria-hidden />
          适用场景
        </div>
        <p className="truncate font-medium text-ink">{model.useCases || "通用"}</p>
      </div>

      {model.imagePrice ? (
        <ImagePriceBlock imagePrice={model.imagePrice} />
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <PriceBlock title="输入" price={model.vipInputPrice} />
          <PriceBlock title="输出" price={model.vipOutputPrice} />
          <PriceBlock title="缓存创建" price={model.vipCacheInputPrice} muted />
          <PriceBlock title="缓存读取" price={model.vipCacheOutputPrice} muted />
        </div>
      )}
    </article>
  );
}

function PriceBlock({ title, price, muted = false }: { title: string; price: ModelMarketplacePrice; muted?: boolean }) {
  const discounted = price.discounted;
  const hasDiscount = discounted < Math.ceil(price.original);
  return (
    <div className={`rounded-xl border px-3 py-3 ${muted ? "border-hairline-subtle bg-surface-subtle/50" : "border-brand/10 bg-brand-soft/40"}`}>
      <p className="text-[11px] font-medium text-ink-secondary">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-bold text-ink">{formatPoints(discounted)}</span>
        <span className="text-[10px] text-ink-tertiary">点 / 100W token</span>
      </div>
      <p className="mt-1 text-[10px] text-ink-tertiary">
        {hasDiscount ? <>原价 <span className="line-through">{formatPoints(price.original)}</span> 点</> : <>原价 {formatPoints(price.original)} 点</>}
      </p>
    </div>
  );
}

function ImagePriceBlock({ imagePrice }: { imagePrice: ModelMarketplaceImagePrice }) {
  const discounted = imagePrice.discountedPoints;
  const hasDiscount = discounted < Math.ceil(imagePrice.originalPoints);
  return (
    <div className="mt-5 rounded-xl border border-brand/10 bg-brand-soft/40 px-3 py-3">
      <p className="text-[11px] font-medium text-ink-secondary">生图（按次计费）</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-bold text-ink">{formatPoints(discounted)}</span>
        <span className="text-[10px] text-ink-tertiary">点 / 张 · {imagePrice.resolution}</span>
      </div>
      <p className="mt-1 text-[10px] text-ink-tertiary">
        {hasDiscount ? <>原价 <span className="line-through">{formatPoints(imagePrice.originalPoints)}</span> 点</> : <>原价 {formatPoints(imagePrice.originalPoints)} 点</>}
      </p>
    </div>
  );
}
