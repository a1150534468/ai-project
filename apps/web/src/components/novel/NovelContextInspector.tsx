import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { getNovelSetup, listNovelCharacters, listNovelProps, listNovelStorylines, type NovelChapter, type NovelSetupPayload, type NovelWorkbenchPayload } from "../../api";
import { NovelReviewPanel } from "../workflow/NovelReviewPanel";

type InspectorTab = "context" | "characters" | "storylines" | "foreshadow" | "world" | "quality";

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const TABS: readonly { id: InspectorTab; label: string; icon: string }[] = [
  { id: "context", label: "本章", icon: "mdi:radar" },
  { id: "characters", label: "人物", icon: "mdi:account-group-outline" },
  { id: "storylines", label: "故事线", icon: "mdi:source-branch" },
  { id: "foreshadow", label: "伏笔", icon: "mdi:bookmark-multiple-outline" },
  { id: "world", label: "世界", icon: "mdi:earth" },
  { id: "quality", label: "质检", icon: "mdi:shield-check-outline" },
];

function Empty({ children }: { readonly children: string }) {
  return <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-[#d9dfdd] px-4 text-center text-xs leading-5 text-[#89928f]">{children}</div>;
}

export function NovelContextInspector({ token, projectId, chapter, workbench, isReviewSaving, onSaveReview, onAnalyze }: { readonly token: string; readonly projectId: string; readonly chapter: NovelChapter | null; readonly workbench: NovelWorkbenchPayload | null; readonly isReviewSaving: boolean; readonly onSaveReview: (payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean }) => void; readonly onAnalyze: () => void }) {
  const [tab, setTab] = useState<InspectorTab>("context");
  const [setup, setSetup] = useState<NovelSetupPayload | null>(null);
  const [characters, setCharacters] = useState<Array<Record<string, unknown>>>([]);
  const [storylines, setStorylines] = useState<Array<Record<string, unknown>>>([]);
  const [props, setProps] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getNovelSetup(token, projectId).catch(() => null),
      listNovelCharacters(token, projectId).catch(() => ({ characters: [], relations: [] })),
      listNovelStorylines(token, projectId).catch(() => []),
      listNovelProps(token, projectId).catch(() => []),
    ]).then(([nextSetup, cast, lines, nextProps]) => {
      if (cancelled) return;
      setSetup(nextSetup); setCharacters(cast.characters); setStorylines(lines); setProps(nextProps);
    });
    return () => { cancelled = true; };
  }, [projectId, token]);

  const highlights = workbench?.workbenchHighlights ?? {};
  const snapshot = record(chapter?.contextSnapshot);
  const snapshotFocus = record(snapshot.focusCard);
  const snapshotBeats = Array.isArray(snapshot.microBeats) ? snapshot.microBeats.map(record) : [];
  const snapshotAlerts = Array.isArray(snapshot.continuityAlerts) ? snapshot.continuityAlerts.map(record) : [];
  const highlightChapterNumber = Number(highlights.focusChapterNumber);
  const highlightsMatchChapter = Boolean(chapter && Number.isFinite(highlightChapterNumber) && highlightChapterNumber === chapter.chapterIndex);
  const focus = Object.keys(snapshotFocus).length > 0 ? snapshotFocus : highlightsMatchChapter ? record(highlights.focusCard) : {};
  const beats = snapshotBeats.length > 0 ? snapshotBeats : highlightsMatchChapter && Array.isArray(highlights.microBeats) ? highlights.microBeats.map(record) : [];
  const alerts = snapshotAlerts.length > 0 ? snapshotAlerts : highlightsMatchChapter && Array.isArray(highlights.continuityAlerts) ? highlights.continuityAlerts.map(record) : [];
  const quality = record(chapter?.consistencyJson);
  const qualityDetail = record(quality.quality);
  const worldDimensions = useMemo(() => {
    const bible = record(setup?.bible);
    return Array.isArray(bible.worldDimensions) ? bible.worldDimensions.map(record) : [];
  }, [setup?.bible]);

  return (
    <aside className="hidden min-h-0 flex-col border-l border-[#dfe5e2] bg-[#fbfcfc] xl:flex">
      <div className="border-b border-[#e5eae8] px-3 py-2"><div className="flex items-center gap-1">{TABS.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} title={item.label} aria-label={item.label} className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg text-[10px] font-semibold transition ${tab === item.id ? "bg-brand-soft px-2 text-brand-ink ring-1 ring-brand/20" : "w-8 px-0 text-[#74807c] "}`}><Icon icon={item.icon} className="shrink-0" /><span className={tab === item.id ? "whitespace-nowrap" : "sr-only"}>{item.label}</span></button>)}</div></div>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-3 [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {tab === "context" && <div className="grid gap-3">
          <section className="rounded-xl border border-[#e2e7e5] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-ink">Chapter Mission</p><h3 className="mt-1 text-sm font-semibold text-[#303936]">第 {chapter?.chapterIndex ?? "-"} 章 · {chapter?.title || "未选择"}</h3><div className="mt-3 grid gap-2 text-xs leading-5 text-[#626c68]"><p><span className="font-semibold text-[#3c4642]">任务：</span>{text(focus.mission) || chapter?.outline || chapter?.summary || "推进主线"}</p><p><span className="font-semibold text-[#3c4642]">冲突：</span>{text(focus.conflict) || "维持场景压力"}</p><p><span className="font-semibold text-[#3c4642]">钩子：</span>{text(focus.endingHook) || "留下下一步问题"}</p></div></section>
          <section className="rounded-xl border border-[#e2e7e5] bg-white p-3"><div className="flex items-center justify-between"><h4 className="text-xs font-semibold text-[#303936]">本章微节拍</h4><span className="text-[10px] text-[#8c9592]">{beats.length} 个</span></div><div className="mt-2 grid gap-2">{beats.slice(0, 6).map((beat, index) => <div key={index} className="rounded-lg bg-[#f4f7f5] p-2"><p className="text-[11px] font-semibold text-[#43504b]">{text(beat.index) || index + 1}. {text(beat.label)} · {text(beat.targetWords)}字</p><p className="mt-1 text-[10px] leading-4 text-[#74807b]">{text(beat.objective)}</p></div>)}{!beats.length && <p className="py-4 text-center text-[11px] text-[#929b98]">生成正文后显示本章实际使用的微节拍</p>}</div></section>
          <section className="rounded-xl border border-[#e2e7e5] bg-white p-3"><h4 className="text-xs font-semibold text-[#303936]">连续性提醒</h4><div className="mt-2 grid gap-2">{alerts.slice(0, 5).map((item, index) => <p key={index} className="rounded-lg bg-amber-50 p-2 text-[10px] leading-4 text-amber-800"><span className="font-semibold">{text(item.title)}</span> · {text(item.detail)}</p>)}{!alerts.length && <p className="text-[11px] text-[#929b98]">当前没有连续性风险</p>}</div></section>
          {props.length > 0 && <section className="rounded-xl border border-[#e2e7e5] bg-white p-3"><h4 className="text-xs font-semibold text-[#303936]">本书道具</h4><div className="mt-2 flex flex-wrap gap-1.5">{props.slice(0, 8).map((item, index) => <span key={text(item.id) || index} className="rounded-full bg-[#edf2f0] px-2 py-1 text-[10px] text-[#5d6864]">{text(item.name)}</span>)}</div></section>}
        </div>}

        {tab === "characters" && <div className="grid gap-2">{characters.map((item, index) => <article key={text(item.id) || index} className="rounded-xl border border-[#e2e7e5] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">{text(item.name).slice(0, 1)}</span><div className="min-w-0"><p className="truncate text-xs font-semibold text-[#303936]">{text(item.name)}</p><p className="text-[10px] text-brand-ink">{text(item.role) || "人物"}</p></div></div><p className="mt-2 line-clamp-4 text-[10px] leading-4 text-[#707b76]">{text(item.coreMotivation) || text(item.description)}</p></article>)}{!characters.length && <Empty>设置向导完成人物生成后显示角色库</Empty>}</div>}

        {tab === "storylines" && <div className="grid gap-2">{storylines.map((item, index) => <article key={text(item.id) || index} className="rounded-xl border border-[#e2e7e5] bg-white p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-[#303936]">{text(item.title)}</p><span className="rounded-full bg-brand-soft px-2 py-0.5 text-[9px] font-semibold text-brand-ink">{text(item.storylineType) || "main"}</span></div><p className="mt-2 text-[10px] leading-4 text-[#707b76]">{text(item.goal) || text(item.conflict)}</p></article>)}{!storylines.length && <Empty>剧情总纲生成后显示主线、支线与暗线</Empty>}</div>}

        {tab === "foreshadow" && <div className="grid gap-2">{(workbench?.foreshadowItems ?? []).map((item, index) => <article key={text(item.id) || index} className="rounded-xl border border-[#e2e7e5] bg-white p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-[#303936]">{text(item.title)}</p><span className="text-[9px] font-semibold text-brand-ink">{text(item.status)}</span></div><p className="mt-1 text-[10px] leading-4 text-[#707b76]">{text(item.description)}</p><p className="mt-2 text-[9px] text-[#909895]">预计第 {text(item.expectedPayoffChapter) || "-"} 章回收</p></article>)}{!workbench?.foreshadowItems?.length && <Empty>章后分析会自动维护伏笔账本</Empty>}</div>}

        {tab === "world" && <div className="grid gap-2">{worldDimensions.map((item, index) => <article key={text(item.id) || index} className="rounded-xl border border-[#e2e7e5] bg-white p-3"><p className="text-xs font-semibold text-[#303936]">{text(item.title)}</p><p className="mt-2 text-[10px] leading-4 text-[#707b76]">{text(item.summary) || JSON.stringify(item.details)}</p></article>)}{(setup?.locations ?? []).slice(0, 8).map((item, index) => <article key={text(item.id) || `location:${index}`} className="rounded-xl border border-[#e2e7e5] bg-white p-3"><p className="flex items-center gap-1 text-xs font-semibold text-[#303936]"><Icon icon="mdi:map-marker-outline" className="text-brand-ink" />{text(item.name)}</p><p className="mt-1 text-[10px] leading-4 text-[#707b76]">{text(item.description)}</p></article>)}{!worldDimensions.length && !setup?.locations.length && <Empty>Bible 和地图生成后显示世界资料</Empty>}</div>}

        {tab === "quality" && <div className="grid gap-3"><section className="grid grid-cols-3 gap-2">{[["质量", text(qualityDetail.score) || text(chapter?.qualityScore) || "-"], ["张力", text(chapter?.tensionScore) || text(qualityDetail.tensionScore) || "-"], ["文风风险", text(qualityDetail.styleRisk) || "low"]].map(([label, value]) => <div key={label} className="rounded-xl border border-[#e2e7e5] bg-white p-2 text-center"><p className="text-[9px] text-[#89928f]">{label}</p><p className="mt-1 text-sm font-semibold text-[#303936]">{value}</p></div>)}</section><NovelReviewPanel chapter={chapter} isSaving={isReviewSaving} onSave={onSaveReview} onAnalyze={onAnalyze} /></div>}
      </div>
    </aside>
  );
}
