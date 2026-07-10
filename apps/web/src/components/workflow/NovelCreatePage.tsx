import { Icon } from "@iconify/react";
import type { CreateNovelInitialSettings } from "../../api";

export interface NovelCreateDraft {
  readonly title: string;
  readonly channel: string;
  readonly coreRequirement: string;
  readonly platforms: readonly string[];
  readonly topics: readonly string[];
  readonly perspective: string;
  readonly styleMode: string;
  readonly era: string;
  readonly hasCheat: "yes" | "no";
  readonly styleTags: readonly string[];
  readonly language: string;
  readonly chapterCount: string;
  readonly chapterChars: string;
}

const CHANNEL_OPTIONS = ["男频长篇", "女频长篇", "短篇", "儿童短篇"] as const;
const PLATFORM_OPTIONS = ["晋江文学城", "番茄", "七猫", "起点", "知乎", "潇湘书院", "云起书院", "豆瓣阅读", "刺猬猫", "Wattpad", "Radish", "Dreame"] as const;
const TOPIC_OPTIONS = ["都市", "言情", "宫斗", "宅斗", "玄幻", "奇幻", "西方玄幻", "仙侠", "科幻", "武侠", "悬疑", "历史", "末世", "游戏", "娱乐圈", "职场", "灵异", "军事"] as const;
const PERSPECTIVE_OPTIONS = ["第一人称", "第三人称"] as const;
const STYLE_MODE_OPTIONS = ["强爽点", "经典作品", "简洁直白", "强悬疑", "知乎短文", "幽默搞笑", "儿童故事"] as const;
const ERA_OPTIONS = ["古代", "现代", "未来", "架空"] as const;
const STYLE_TAG_OPTIONS = [
  "总裁文", "穿越文", "纯爱", "虐恋文", "甜宠文", "种田文", "女强文", "宫斗文", "娱乐圈文", "年代文",
  "无CP", "替身文", "脑洞文", "团宠文", "医妃文", "军恋文", "穿书文", "读心流", "替嫁流", "攻略文",
  "真假千金文", "先婚后爱流", "映美文", "随身文", "进化文", "异能文", "悬疑文", "推理文", "灵异文", "无限流",
  "升级流", "打脸文", "经营文", "反套路", "强强文", "救赎文", "暗黑文", "学霸文", "神医文", "嫡女文",
] as const;

export function createDefaultNovelDraft(): NovelCreateDraft {
  return {
    title: "",
    channel: "男频长篇",
    coreRequirement: "视角：第三人称；金手指：否；章节数：12；每章约 5000 字；语言：中文",
    platforms: ["番茄", "起点"],
    topics: ["玄幻"],
    perspective: "第三人称",
    styleMode: "强爽点",
    era: "古代",
    hasCheat: "no",
    styleTags: ["升级流"],
    language: "中文",
    chapterCount: "12",
    chapterChars: "5000",
  };
}

export function novelCreateGenre(draft: NovelCreateDraft): string {
  return [draft.channel, ...draft.topics.slice(0, 2)].filter(Boolean).join(" · ");
}

export function novelCreateInitialSettings(draft: NovelCreateDraft): CreateNovelInitialSettings {
  const chapterCount = Number.parseInt(draft.chapterCount, 10);
  const chapterChars = Number.parseInt(draft.chapterChars, 10);
  return {
    channel: draft.channel,
    coreRequirement: draft.coreRequirement,
    platforms: [...draft.platforms],
    topics: [...draft.topics],
    perspective: draft.perspective,
    styleMode: draft.styleMode,
    era: draft.era,
    hasCheat: draft.hasCheat === "yes",
    styleTags: [...draft.styleTags],
    language: draft.language,
    chapterCount: Number.isFinite(chapterCount) ? chapterCount : undefined,
    chapterChars: Number.isFinite(chapterChars) ? chapterChars : undefined,
  };
}

function toggleListValue(values: readonly string[], value: string, max?: number): string[] {
  if (values.includes(value)) return values.filter((item) => item !== value);
  if (max !== undefined && values.length >= max) return [...values];
  return [...values, value];
}

function ChipButton({
  active,
  children,
  onClick,
}: {
  readonly active: boolean;
  readonly children: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 rounded-[8px] border px-3 text-xs font-semibold transition ${
        active ? "border-brand bg-brand-soft text-brand-ink" : "border-[#d2d2d7] bg-white text-[#1d1d1f] hover:border-brand/40"
      }`}
    >
      {children}
    </button>
  );
}

export function NovelCreatePage({
  draft,
  canGoBack,
  isSubmitting,
  onBack,
  onChange,
  onSubmit,
}: {
  readonly draft: NovelCreateDraft;
  readonly canGoBack: boolean;
  readonly isSubmitting: boolean;
  readonly onBack: () => void;
  readonly onChange: (draft: NovelCreateDraft) => void;
  readonly onSubmit: () => void;
}) {
  const update = (patch: Partial<NovelCreateDraft>) => onChange({ ...draft, ...patch });
  return (
    <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
      <div className="flex flex-col gap-3 border-b border-[#e8e8ed] pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
            className="inline-flex h-9 items-center gap-2 rounded-[9px] border border-[#d2d2d7] px-3 text-sm font-semibold disabled:opacity-50"
          >
            <Icon icon="mdi:arrow-left" aria-hidden />
            书架
          </button>
          <h2 className="text-lg font-semibold text-[#1d1d1f]">新建作品</h2>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        <label className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
          作品名
          <input
            value={draft.title}
            onChange={(event) => update({ title: event.currentTarget.value })}
            placeholder="如：剑来"
            className="h-11 rounded-[8px] border border-[#d2d2d7] px-3 text-sm outline-none focus:border-brand/60"
          />
        </label>

        <div className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
          频道
          <div className="grid gap-2 sm:grid-cols-2">
            {CHANNEL_OPTIONS.map((option) => (
              <ChipButton key={option} active={draft.channel === option} onClick={() => update({ channel: option })}>{option}</ChipButton>
            ))}
          </div>
        </div>

        <label className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
          核心要求
          <textarea
            value={draft.coreRequirement}
            onChange={(event) => update({ coreRequirement: event.currentTarget.value })}
            rows={4}
            className="resize-y rounded-[8px] border border-[#d2d2d7] p-3 text-sm leading-6 outline-none focus:border-brand/60"
          />
        </label>

        <OptionGroup title="平台" options={PLATFORM_OPTIONS} values={draft.platforms} onToggle={(value) => update({ platforms: toggleListValue(draft.platforms, value) })} />
        <OptionGroup title="题材" options={TOPIC_OPTIONS} values={draft.topics} onToggle={(value) => update({ topics: toggleListValue(draft.topics, value) })} />
        <SingleOptionGroup title="视角" options={PERSPECTIVE_OPTIONS} value={draft.perspective} onChange={(value) => update({ perspective: value })} />
        <SingleOptionGroup title="文风模式" options={STYLE_MODE_OPTIONS} value={draft.styleMode} onChange={(value) => update({ styleMode: value })} />
        <SingleOptionGroup title="年代" options={ERA_OPTIONS} value={draft.era} onChange={(value) => update({ era: value })} />
        <SingleOptionGroup title="是否金手指" options={["否", "是"]} value={draft.hasCheat === "yes" ? "是" : "否"} onChange={(value) => update({ hasCheat: value === "是" ? "yes" : "no" })} />
        <OptionGroup title="风格标签（最多5）" options={STYLE_TAG_OPTIONS} values={draft.styleTags} onToggle={(value) => update({ styleTags: toggleListValue(draft.styleTags, value, 5) })} />
        <SingleOptionGroup title="语言" options={["中文", "英文"]} value={draft.language} onChange={(value) => update({ language: value })} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
            章节数
            <input value={draft.chapterCount} onChange={(event) => update({ chapterCount: event.currentTarget.value })} inputMode="numeric" className="h-11 rounded-[8px] border border-[#d2d2d7] px-3 text-sm" />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
            每章字数
            <input value={draft.chapterChars} onChange={(event) => update({ chapterChars: event.currentTarget.value })} inputMode="numeric" className="h-11 rounded-[8px] border border-[#d2d2d7] px-3 text-sm" />
          </label>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className="mt-2 flex h-11 items-center justify-center rounded-[10px] bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-hover disabled:bg-brand/40"
        >
          {isSubmitting ? "创建中" : "创建作品"}
        </button>
      </div>
    </section>
  );
}

function OptionGroup({
  title,
  options,
  values,
  onToggle,
}: {
  readonly title: string;
  readonly options: readonly string[];
  readonly values: readonly string[];
  readonly onToggle: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
      {title}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <ChipButton key={option} active={values.includes(option)} onClick={() => onToggle(option)}>{option}</ChipButton>
        ))}
      </div>
    </div>
  );
}

function SingleOptionGroup({
  title,
  options,
  value,
  onChange,
}: {
  readonly title: string;
  readonly options: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
      {title}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <ChipButton key={option} active={value === option} onClick={() => onChange(option)}>{option}</ChipButton>
        ))}
      </div>
    </div>
  );
}
