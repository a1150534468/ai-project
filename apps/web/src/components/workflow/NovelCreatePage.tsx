import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { CreateNovelInitialSettings } from "../../api";

export type NovelLengthTier = "starter" | "standard" | "long" | "epic";

export interface NovelCreateDraft {
  readonly title: string;
  readonly premise: string;
  readonly market: string;
  readonly subgenre: string;
  readonly worldPreset: string;
  readonly storyStructure: string;
  readonly pacingControl: string;
  readonly writingStyle: string;
  readonly specialRequirements: string;
  readonly lengthTier: NovelLengthTier;
  readonly chapterCount: string;
  readonly chapterChars: string;
}

type Taxonomy = {
  readonly label: string;
  readonly icon: string;
  readonly topics: readonly string[];
  readonly world: string;
  readonly structure: string;
  readonly pacing: string;
  readonly style: string;
};

const MARKET_TAXONOMY: readonly Taxonomy[] = [
  { label: "男频", icon: "mdi:sword-cross", topics: ["东方玄幻", "都市异能", "仙侠武侠", "科幻末世", "历史争霸", "悬疑探险"], world: "规则清晰、成长路径可验证的高压世界", structure: "目标升级与阶段破局并行的长线结构", pacing: "强钩子开局，小循环持续兑现", style: "动作明确、信息密度高、情绪反馈直接" },
  { label: "女频", icon: "mdi:flower-tulip-outline", topics: ["现代言情", "古代言情", "幻想言情", "悬疑推理", "青春成长", "职场群像"], world: "关系与身份秩序驱动的沉浸式世界", structure: "人物关系变化牵引主线的长线结构", pacing: "情绪递进与关系转折交替", style: "细腻克制、人物感受与对话并重" },
  { label: "精品故事", icon: "mdi:book-open-page-variant-outline", topics: ["现实主义", "历史传奇", "科幻寓言", "社会悬疑", "家庭伦理", "成长疗愈"], world: "主题、人物与时代背景彼此咬合", structure: "围绕核心命题收束的精炼结构", pacing: "场景有效、转折克制、结尾回响", style: "准确、耐读，重视意象与人物弧光" },
];

const LENGTH_TIERS: readonly { value: NovelLengthTier; title: string; hint: string; chapters: number; chars: number }[] = [
  { value: "starter", title: "轻量长篇", hint: "约 10 万字 · 40 章", chapters: 40, chars: 2500 },
  { value: "standard", title: "标准长篇", hint: "约 30 万字 · 100 章", chapters: 100, chars: 3000 },
  { value: "long", title: "大型长篇", hint: "约 60 万字 · 180 章", chapters: 180, chars: 3300 },
  { value: "epic", title: "史诗长篇", hint: "约 100 万字 · 280 章", chapters: 280, chars: 3600 },
];

function currentTaxonomy(draft: NovelCreateDraft): Taxonomy {
  return MARKET_TAXONOMY.find((item) => item.label === draft.market) ?? MARKET_TAXONOMY[0]!;
}

export function createDefaultNovelDraft(): NovelCreateDraft {
  const taxonomy = MARKET_TAXONOMY[0]!;
  const length = LENGTH_TIERS[1]!;
  return {
    title: "",
    premise: "",
    market: taxonomy.label,
    subgenre: taxonomy.topics[0]!,
    worldPreset: taxonomy.world,
    storyStructure: taxonomy.structure,
    pacingControl: taxonomy.pacing,
    writingStyle: taxonomy.style,
    specialRequirements: "保持人物动机连续，伏笔有明确回收窗口，每章结尾保留有效推进钩子。",
    lengthTier: length.value,
    chapterCount: String(length.chapters),
    chapterChars: String(length.chars),
  };
}

export function novelCreateTitle(draft: NovelCreateDraft): string {
  const explicit = draft.title.trim();
  if (explicit) return explicit;
  const firstSentence = draft.premise.trim().split(/[。！？\n]/u).find(Boolean)?.trim() ?? "";
  return firstSentence.slice(0, 18) || "未命名新作";
}

export function novelCreateGenre(draft: NovelCreateDraft): string {
  return [draft.market, draft.subgenre].filter(Boolean).join(" · ");
}

export function novelCreateInitialSettings(draft: NovelCreateDraft): CreateNovelInitialSettings {
  const chapterCount = Number.parseInt(draft.chapterCount, 10);
  const chapterChars = Number.parseInt(draft.chapterChars, 10);
  return {
    channel: draft.market,
    coreRequirement: [
      `【故事梗概】\n${draft.premise.trim()}`,
      `【世界预设】\n${draft.worldPreset.trim()}`,
      `【故事结构】\n${draft.storyStructure.trim()}`,
      `【节奏控制】\n${draft.pacingControl.trim()}`,
      `【写作风格】\n${draft.writingStyle.trim()}`,
      `【特殊要求】\n${draft.specialRequirements.trim()}`,
    ].join("\n\n"),
    topics: [draft.subgenre],
    perspective: "第三人称",
    styleMode: draft.writingStyle,
    styleTags: [draft.subgenre, "长篇叙事"],
    language: "中文",
    chapterCount: Number.isFinite(chapterCount) ? chapterCount : undefined,
    chapterChars: Number.isFinite(chapterChars) ? chapterChars : undefined,
  };
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const taxonomy = useMemo(() => currentTaxonomy(draft), [draft.market]);
  const update = (patch: Partial<NovelCreateDraft>) => onChange({ ...draft, ...patch });
  const chooseMarket = (item: Taxonomy) => update({
    market: item.label,
    subgenre: item.topics[0]!,
    worldPreset: item.world,
    storyStructure: item.structure,
    pacingControl: item.pacing,
    writingStyle: item.style,
  });
  const chooseLength = (value: NovelLengthTier) => {
    const option = LENGTH_TIERS.find((item) => item.value === value)!;
    update({ lengthTier: value, chapterCount: String(option.chapters), chapterChars: String(option.chars) });
  };
  const ready = draft.premise.trim().length >= 10 && draft.subgenre.trim().length > 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline-subtle bg-white shadow-[0_18px_60px_rgba(15,23,42,0.07)]">
      <div className="border-b border-hairline-subtle bg-[#f5f5f7] px-5 py-5 sm:px-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {canGoBack && <button type="button" onClick={onBack} className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-hairline bg-white text-ink-secondary" aria-label="返回书库"><Icon icon="mdi:arrow-left" /></button>}
            <div>
              <p className="flex items-center gap-2 text-xs font-bold text-brand-ink"><Icon icon="mdi:creation-outline" /> STORY FOUNDRY</p>
              <h2 className="mt-1 text-xl font-semibold text-ink">把一个故事想法，变成长篇叙事工程</h2>
              <p className="mt-1 text-sm leading-6 text-ink-secondary">先写清主线与读者期待，系统会在设置向导中逐步生成文风、世界、人物、地图和剧情总纲。</p>
            </div>
          </div>
          <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-hairline bg-white px-3 text-xs font-semibold text-ink-secondary">
            <Icon icon={showAdvanced ? "mdi:tune-vertical-variant" : "mdi:tune-variant"} />
            {showAdvanced ? "使用篇幅档位" : "高级设置"}
          </button>
        </div>
      </div>

      <div className="grid gap-6 p-5 sm:p-7">
        <label className="grid gap-2">
          <span className="flex items-center justify-between gap-3 text-sm font-semibold text-ink"><span>故事梗概</span><span className="text-xs font-normal text-[#929996]">{draft.premise.length}/2000</span></span>
          <textarea
            value={draft.premise}
            onChange={(event) => update({ premise: event.currentTarget.value.slice(0, 2000) })}
            placeholder="用一段话写清主角、核心困境、主线目标与爽点预期……\n\n例如：被逐出宗门的阵法师发现自己能听见古阵残响，他必须在王朝封锁前修复失落阵图，也逐渐发现师门覆灭与皇室气运有关。"
            rows={6}
            className="w-full resize-y rounded-2xl border border-hairline bg-[#fbfcfc] p-4 text-sm leading-7 text-ink outline-none transition placeholder:text-ink-tertiary focus:border-brand/60 focus:bg-white focus:ring-4 focus:ring-brand/10"
          />
        </label>

        <div className="grid gap-3">
          <div><p className="text-sm font-semibold text-ink">市场分区</p><p className="mt-1 text-xs text-ink-tertiary">大类 → 细分主题；选择后自动推导世界、结构、节奏与文风，后续都可修改。</p></div>
          <div className="flex flex-wrap gap-2">
            {MARKET_TAXONOMY.map((item) => <button key={item.label} type="button" onClick={() => chooseMarket(item)} className={`flex h-10 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition ${draft.market === item.label ? "border-brand bg-brand text-white shadow-sm" : "border-hairline bg-white text-ink-secondary "}`}><Icon icon={item.icon} />{item.label}</button>)}
          </div>
          <div className="flex flex-wrap gap-2 rounded-2xl bg-[#f6f8f7] p-3">
            {taxonomy.topics.map((topic) => <button key={topic} type="button" onClick={() => update({ subgenre: topic })} className={`h-8 rounded-lg px-3 text-xs font-semibold transition ${draft.subgenre === topic ? "bg-white text-brand-ink shadow-sm ring-1 ring-brand/30" : "text-ink-secondary "}`}>{topic}</button>)}
          </div>
        </div>

        {!showAdvanced ? (
          <div className="grid gap-3">
            <div><p className="text-sm font-semibold text-ink">目标篇幅</p><p className="mt-1 text-xs text-ink-tertiary">按网文常用节奏推导章数与单章字数。</p></div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {LENGTH_TIERS.map((option) => <button key={option.value} type="button" onClick={() => chooseLength(option.value)} className={`rounded-xl border p-3 text-left transition ${draft.lengthTier === option.value ? "border-brand bg-brand-soft ring-1 ring-brand/20" : "border-hairline-subtle bg-white "}`}><span className="block text-sm font-semibold text-ink">{option.title}</span><span className="mt-1 block text-xs text-ink-tertiary">{option.hint}</span></button>)}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 rounded-2xl border border-hairline-subtle bg-[#f8faf9] p-4 sm:grid-cols-3">
            <label className="grid gap-2 text-xs font-semibold text-ink-secondary">书名（可留空由梗概生成）<input value={draft.title} onChange={(event) => update({ title: event.currentTarget.value })} className="h-10 rounded-xl border border-hairline bg-white px-3 text-sm text-ink outline-none focus:border-brand/60" placeholder="未命名新作" /></label>
            <label className="grid gap-2 text-xs font-semibold text-ink-secondary">章节数<input value={draft.chapterCount} onChange={(event) => update({ chapterCount: event.currentTarget.value })} inputMode="numeric" className="h-10 rounded-xl border border-hairline bg-white px-3 text-sm text-ink outline-none focus:border-brand/60" /></label>
            <label className="grid gap-2 text-xs font-semibold text-ink-secondary">每章字数<input value={draft.chapterChars} onChange={(event) => update({ chapterChars: event.currentTarget.value })} inputMode="numeric" className="h-10 rounded-xl border border-hairline bg-white px-3 text-sm text-ink outline-none focus:border-brand/60" /></label>
          </div>
        )}

        <details className="group rounded-2xl border border-hairline-subtle bg-white">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink-secondary"><span className="flex items-center gap-2"><Icon icon="mdi:layers-triple-outline" className="text-brand-ink" />查看自动推导的创作约束</span><Icon icon="mdi:chevron-down" className="transition group-open:rotate-180" /></summary>
          <div className="grid gap-3 border-t border-hairline-subtle p-4 sm:grid-cols-2">
            {([
              ["世界预设", "worldPreset"], ["故事结构", "storyStructure"], ["节奏控制", "pacingControl"], ["写作风格", "writingStyle"], ["特殊要求", "specialRequirements"],
            ] as const).map(([label, key]) => <label key={key} className={`grid gap-1.5 text-xs font-semibold text-ink-secondary ${key === "specialRequirements" ? "sm:col-span-2" : ""}`}>{label}<textarea value={draft[key]} onChange={(event) => update({ [key]: event.currentTarget.value })} rows={3} className="resize-y rounded-xl border border-hairline bg-[#fbfcfc] p-3 text-sm leading-6 text-ink outline-none focus:border-brand/60" /></label>)}
          </div>
        </details>

        <div className="flex flex-col gap-3 border-t border-hairline-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-ink-tertiary"><Icon icon="mdi:shield-check-outline" className="mr-1 inline text-brand-ink" />创建后先进入可修改的设置向导，不会直接开始整书生成。</p>
          <button type="button" onClick={onSubmit} disabled={!ready || isSubmitting} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-45"><Icon icon={isSubmitting ? "mdi:loading" : "mdi:creation-outline"} className={isSubmitting ? "animate-spin" : ""} />{isSubmitting ? "正在建档" : "建档并进入设置向导"}</button>
        </div>
      </div>
    </section>
  );
}
