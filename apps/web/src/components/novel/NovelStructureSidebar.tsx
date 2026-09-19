import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import type { NovelChapter, NovelStructureNode } from "../../api";

const NODE_LABELS: Record<string, string> = { book: "书", volume: "卷", act: "幕", chapter: "章" };

function chapterState(chapter: NovelChapter | undefined): { label: string; className: string } {
  if (!chapter || !(chapter.hasContent ?? Boolean(chapter?.content?.trim()))) return { label: "待写", className: "bg-surface-muted text-ink-tertiary" };
  if (chapter.reviewStatus === "approved") return { label: "定稿", className: "bg-brand-soft text-brand-ink" };
  if (chapter.reviewStatus === "revise") return { label: "修订", className: "bg-warning/15 text-warning-ink" };
  return { label: "草稿", className: "bg-info/15 text-info-ink" };
}

export function NovelStructureSidebar({
  nodes,
  chapters,
  selectedChapterId,
  runningChapter,
  onSelectChapter,
  onCreateChapter,
  onOpenPlanning,
}: {
  readonly nodes: readonly NovelStructureNode[];
  readonly chapters: readonly NovelChapter[];
  readonly selectedChapterId: string;
  readonly runningChapter?: number | null;
  readonly onSelectChapter: (chapterId: string) => void;
  readonly onCreateChapter: () => void;
  readonly onOpenPlanning: () => void;
}) {
  const [flat, setFlat] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const chaptersByNumber = useMemo(() => new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter])), [chapters]);
  const childMap = useMemo(() => {
    const map = new Map<string | null, NovelStructureNode[]>();
    for (const node of nodes) map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
    for (const children of map.values()) children.sort((a, b) => a.number - b.number);
    return map;
  }, [nodes]);
  const normalizedQuery = query.trim().toLowerCase();

  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderNode = (node: NovelStructureNode, depth = 0): ReactNode => {
    const children = childMap.get(node.id) ?? [];
    const isChapter = node.nodeType === "chapter";
    const chapter = isChapter ? chaptersByNumber.get(node.number) : undefined;
    const active = chapter?.id === selectedChapterId;
    const hidden = collapsed.has(node.id);
    if (normalizedQuery && !`${node.title} ${node.description} ${node.outline}`.toLowerCase().includes(normalizedQuery) && !children.some((child) => `${child.title} ${child.description} ${child.outline}`.toLowerCase().includes(normalizedQuery))) return null;
    const state = chapterState(chapter);
    return <div key={node.id}>
      <button type="button" onClick={() => isChapter && chapter ? onSelectChapter(chapter.id) : toggle(node.id)} className={`group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition ${active ? "bg-brand-soft text-brand-ink ring-1 ring-brand/20" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }}>
        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-ink-tertiary">{children.length ? <Icon icon={hidden ? "mdi:chevron-right" : "mdi:chevron-down"} /> : <Icon icon={(chapter?.hasContent ?? Boolean(chapter?.content?.trim())) ? "mdi:file-document-check-outline" : "mdi:file-document-outline"} />}</span>
        <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-[10px] font-bold uppercase text-ink-tertiary">{NODE_LABELS[node.nodeType] ?? node.nodeType}</span><span className="truncate text-xs font-semibold text-ink">{node.title}</span>{runningChapter === node.number && isChapter && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand" />}</span>{isChapter && <span className="mt-1 flex items-center gap-1.5"><span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${state.className}`}>{state.label}</span><span className="text-[9px] text-ink-tertiary">{chapter?.billableChars ?? 0} 字</span></span>}</span>
      </button>
      {!hidden && children.map((child) => renderNode(child, depth + 1))}
    </div>;
  };

  const flatChapters = chapters.filter((chapter) => !normalizedQuery || `${chapter.title} ${chapter.summary}`.toLowerCase().includes(normalizedQuery));

  return (
    <aside className="hidden min-h-0 flex-col border-r border-hairline-subtle bg-surface-subtle xl:flex">
      <div className="border-b border-hairline-subtle p-3">
        <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-semibold text-ink">叙事结构</p><p className="mt-0.5 text-[10px] text-ink-tertiary">{chapters.length} 章 · 部卷幕章</p></div><button type="button" onClick={onCreateChapter} className="grid h-8 w-8 place-items-center rounded-lg border border-brand/25 bg-surface text-brand-ink" title="新建章节"><Icon icon="mdi:plus" /></button></div>
        <label className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 text-xs text-ink-tertiary transition focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/10"><Icon icon="mdi:magnify" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索章节或节点" className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 outline-none shadow-none focus:border-0 focus:shadow-none" /></label>
        <div className="mt-2 grid grid-cols-2 rounded-lg bg-surface-muted p-1"><button type="button" onClick={() => setFlat(false)} className={`h-7 rounded-md text-[10px] font-semibold ${!flat ? "bg-surface text-brand-ink shadow-sm" : "text-ink-tertiary"}`}>结构树</button><button type="button" onClick={() => setFlat(true)} className={`h-7 rounded-md text-[10px] font-semibold ${flat ? "bg-surface text-brand-ink shadow-sm" : "text-ink-tertiary"}`}>平铺章节</button></div>
      </div>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-2 [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {flat ? flatChapters.map((chapter) => { const state = chapterState(chapter); return <button key={chapter.id} type="button" onClick={() => onSelectChapter(chapter.id)} className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left ${selectedChapterId === chapter.id ? "bg-brand-soft ring-1 ring-brand/20" : ""}`}><span className="mt-0.5 text-[10px] font-bold text-ink-tertiary">{String(chapter.chapterIndex).padStart(3, "0")}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-ink">{chapter.title || `第 ${chapter.chapterIndex} 章`}</span><span className="mt-1 flex items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${state.className}`}>{state.label}</span><span className="text-[9px] text-ink-tertiary">{chapter.billableChars} 字</span></span></span></button>; }) : (childMap.get(null) ?? []).map((node) => renderNode(node))}
        {!nodes.length && !chapters.length && <div className="grid min-h-40 place-items-center px-4 text-center"><div><Icon icon="mdi:file-tree-outline" className="mx-auto text-3xl text-ink-tertiary" /><p className="mt-2 text-xs text-ink-tertiary">完成剧情总纲后生成结构树</p></div></div>}
      </div>
      <div className="border-t border-hairline-subtle p-3"><button type="button" onClick={onOpenPlanning} className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-hairline bg-surface text-xs font-semibold text-ink-secondary"><Icon icon="mdi:timeline-text-outline" className="text-brand-ink" />幕级规划</button></div>
    </aside>
  );
}
