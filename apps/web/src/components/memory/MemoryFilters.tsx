import { Icon } from "@iconify/react";
import { MEMORY_TYPE_ORDER, getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryType } from "../../memoryTypes";
import { Switch, buttonClass, cx } from "../ui";
import { memoryChipClass } from "./memoryStyles";
import type { MemoryPending } from "./useMemoryGalaxyState";

/** 库里一共多少条、当前筛选后露出多少条、上一次搜索命中多少条。 */
export interface MemoryCounts {
  readonly total: number;
  readonly visible: number;
  readonly hit: number;
}

interface MemoryFiltersProps {
  readonly enabled: boolean;
  readonly pending: MemoryPending | null;
  readonly query: string;
  readonly activeTypes: readonly MemoryType[];
  readonly counts: MemoryCounts;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onToggleEnabled: () => void;
  readonly onToggleType: (type: MemoryType) => void;
}

/** 搜索框和它右边的开关共用这一身「44 高 + 弱底 + 细描边」，分开写迟早飘。 */
const FIELD_SHELL = "h-11 rounded-[10px] border border-hairline bg-surface-subtle";

/**
 * 搜索。名字由 label 里那段 sr-only 文字给 —— 版面上没地方放可见 label，
 * 但只挂 placeholder 的输入框读屏念不出名字，而包一层 label 比配 id + aria-label 少一个要对上的地方。
 */
function SearchField({
  query,
  searching,
  onQueryChange,
  onSearch,
}: {
  readonly query: string;
  readonly searching: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
}) {
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <label className={cx("relative flex min-w-0 flex-1 items-center", FIELD_SHELL)}>
        <span className="sr-only">搜索记忆</span>
        <Icon icon="mdi:magnify" aria-hidden className="pointer-events-none absolute left-3 text-lg text-ink-tertiary" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索标题、内容或标签"
          className="h-full w-full min-w-0 bg-transparent pl-10 pr-3 text-sm text-ink outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={searching}
        className={buttonClass({ size: "xl", shape: "rounded", className: "w-full flex-none sm:w-auto" })}
      >
        <Icon icon={searching ? "mdi:loading" : "mdi:magnify"} aria-hidden className={cx("text-lg", searching && "animate-spin")} />
        搜索
      </button>
    </form>
  );
}

/** 五个类型一排，勾上的染类型色。单选那种场景用 `memoryChipClass` 的 neutral 档，这里是多选所以走默认档。 */
function TypeChips({
  activeTypes,
  onToggleType,
}: {
  readonly activeTypes: readonly MemoryType[];
  readonly onToggleType: (type: MemoryType) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="按类型筛选">
      {MEMORY_TYPE_ORDER.map((type) => {
        const active = activeTypes.includes(type);

        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            onClick={() => onToggleType(type)}
            className={cx(
              "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition",
              memoryChipClass(type, active),
            )}
          >
            {/* bg-current 借按钮自己的文字色，省一次类型色查表 */}
            <span className="h-2 w-2 rounded-full bg-current opacity-80" />
            {getMemoryTypeMeta(type).label}
          </button>
        );
      })}
    </div>
  );
}

export default function MemoryFilters(props: MemoryFiltersProps) {
  const { counts, enabled, pending } = props;

  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-surface p-4">
      <div className="flex flex-col gap-4">
        {/* 窄屏一列叠着，xl 才把「搜索」和「计数 + 开关」摆成一行 */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <SearchField
            query={props.query}
            searching={pending === "search"}
            onQueryChange={props.onQueryChange}
            onSearch={props.onSearch}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center xl:flex-nowrap">
            <p className="rounded-[10px] bg-surface-subtle px-3 py-2 text-xs leading-5 text-ink-secondary">
              共 {counts.total} 条，显示 {counts.visible} 条，命中 {counts.hit} 条
            </p>
            <Switch
              checked={enabled}
              label={enabled ? "长期记忆已启用" : "长期记忆已关闭"}
              onToggle={props.onToggleEnabled}
              disabled={pending === "toggle"}
              className={cx("min-w-0 px-3", FIELD_SHELL)}
            />
          </div>
        </div>

        <TypeChips activeTypes={props.activeTypes} onToggleType={props.onToggleType} />
      </div>
    </section>
  );
}
