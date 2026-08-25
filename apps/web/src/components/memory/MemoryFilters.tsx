import { Icon } from "@iconify/react";
import type { MemoryType } from "../../memoryTypes";
import { MEMORY_TYPE_ORDER, getMemoryTypeMeta } from "../../memoryGalaxy";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

interface MemoryFiltersProps {
  readonly enabled: boolean;
  readonly togglePending: boolean;
  readonly onToggleEnabled: () => void;
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly searchPending: boolean;
  readonly activeTypes: readonly MemoryType[];
  readonly onToggleType: (type: MemoryType) => void;
  readonly total: number;
  readonly visibleCount: number;
  readonly highlightedCount: number;
}

export default function MemoryFilters({
  enabled,
  togglePending,
  onToggleEnabled,
  query,
  onQueryChange,
  onSearch,
  searchPending,
  activeTypes,
  onToggleType,
  total,
  visibleCount,
  highlightedCount,
}: MemoryFiltersProps) {
  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-white p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <form
            className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Icon
                icon="mdi:magnify"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-ink-tertiary"
                aria-hidden
              />
              <input
                id="memory-search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="搜索标题、内容或标签"
                className="h-11 w-full rounded-[10px] border border-hairline bg-surface-subtle pl-10 pr-3 text-sm text-ink"
              />
            </div>
            <button
              type="submit"
              disabled={searchPending}
              className="inline-flex h-11 w-full flex-none items-center justify-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-medium text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              <Icon
                icon={searchPending ? "mdi:loading" : "mdi:magnify"}
                className={searchPending ? "animate-spin text-lg" : "text-lg"}
                aria-hidden
              />
              搜索
            </button>
          </form>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center xl:flex-nowrap">
            <div className="rounded-[10px] bg-surface-subtle px-3 py-2 text-xs leading-5 text-ink-secondary">
              共 {total} 条，显示 {visibleCount} 条，命中 {highlightedCount} 条
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={onToggleEnabled}
              disabled={togglePending}
              className="inline-flex h-11 min-w-0 items-center justify-between gap-3 rounded-[10px] border border-hairline bg-surface-subtle px-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="min-w-0 truncate text-sm font-medium text-ink">
                {enabled ? "长期记忆已启用" : "长期记忆已关闭"}
              </span>
              <span
                className={`relative inline-flex h-6 w-11 flex-none rounded-full transition ${
                  enabled ? "bg-brand" : "bg-[#d2d2d7]"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${
                    enabled ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {MEMORY_TYPE_ORDER.map((type) => {
            const meta = getMemoryTypeMeta(type);
            const isActive = activeTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => onToggleType(type)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                  isActive
                    ? MEMORY_TYPE_STYLES[type].filterActive
                    : MEMORY_TYPE_STYLES[type].filterInactive
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-current opacity-80" />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
