import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { NovelProjectSummary } from "../../api";
import { NovelCreatePage, type NovelCreateDraft } from "../workflow/NovelCreatePage";

function formatUpdate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function NovelLibraryPage({
  projects,
  loading,
  draft,
  isCreating,
  error,
  onDraftChange,
  onCreate,
  onOpenProject,
  onDeleteProject,
}: {
  readonly projects: readonly NovelProjectSummary[];
  readonly loading: boolean;
  readonly draft: NovelCreateDraft;
  readonly isCreating: boolean;
  readonly error: string;
  readonly onDraftChange: (draft: NovelCreateDraft) => void;
  readonly onCreate: () => void;
  readonly onOpenProject: (projectId: string) => void;
  readonly onDeleteProject: (project: NovelProjectSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => `${project.title} ${project.genre}`.toLowerCase().includes(normalized));
  }, [projects, query]);

  const toggleSelected = (projectId: string) => setSelected((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]);
  const removeSelected = () => {
    const targets = projects.filter((project) => selected.includes(project.id));
    if (!targets.length || !window.confirm(`确定删除选中的 ${targets.length} 本作品吗？`)) return;
    targets.forEach(onDeleteProject);
    setSelected([]);
  };

  return (
    <section className="mx-auto grid w-full max-w-[1500px] gap-8 px-4 pb-32 pt-6 lg:px-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-ink"><Icon icon="mdi:bookshelf" /> Novel Studio</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#17201e]">长篇叙事工作台</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#68716f]">从故事种子、世界与人物，到章节生产、叙事治理和全托管运行，都在同一个作品空间完成。</p>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-2xl border border-[#e1e5e3] bg-white p-2 text-center shadow-sm">
          <div className="px-3 py-1"><p className="text-lg font-semibold text-[#202725]">{projects.length}</p><p className="text-[10px] text-[#8a928f]">作品</p></div>
          <div className="border-x border-[#edf0ef] px-3 py-1"><p className="text-lg font-semibold text-[#202725]">{projects.filter((project) => project.status === "active").length}</p><p className="text-[10px] text-[#8a928f]">创作中</p></div>
          <div className="px-3 py-1"><p className="text-lg font-semibold text-brand-ink">AI</p><p className="text-[10px] text-[#8a928f]">协同</p></div>
        </div>
      </header>

      <NovelCreatePage draft={draft} canGoBack={false} isSubmitting={isCreating} onBack={() => undefined} onChange={onDraftChange} onSubmit={onCreate} />
      {error && <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <section className="grid gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3"><h2 className="text-xl font-semibold text-[#202725]">我的书目</h2><span className="rounded-full bg-[#eaf1ef] px-2.5 py-1 text-xs font-semibold text-[#62706c]">{visible.length} 本</span></div>
          <div className="flex flex-wrap gap-2">
            <label className="flex h-10 min-w-56 items-center gap-2 rounded-xl border border-[#d9dfdd] bg-white px-3 text-sm text-[#69726f] shadow-sm transition focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/10"><Icon icon="mdi:magnify" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索书名或类型" className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 outline-none shadow-none focus:border-0 focus:shadow-none" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><Icon icon="mdi:close-circle" /></button>}</label>
            {selected.length > 0 && <button type="button" onClick={removeSelected} className="h-10 rounded-xl border border-red-200 bg-white px-3 text-xs font-semibold text-red-600">删除选中 ({selected.length})</button>}
          </div>
        </div>

        {loading && <div className="grid min-h-52 place-items-center rounded-2xl border border-dashed border-[#d9dfdd] bg-white"><p className="flex items-center gap-2 text-sm font-semibold text-[#65706c]"><Icon icon="mdi:loading" className="animate-spin text-xl text-brand-ink" />加载书目中</p></div>}

        {!loading && projects.length === 0 && <div className="grid min-h-60 place-items-center rounded-2xl border border-dashed border-[#d9dfdd] bg-white px-6 text-center"><div><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-brand-soft text-3xl text-brand-ink"><Icon icon="mdi:book-plus-outline" /></div><h3 className="mt-4 text-base font-semibold text-[#26302d]">还没有书目</h3><p className="mt-2 text-sm text-[#7d8582]">在上方写下故事创意，创建第一本书。</p></div></div>}

        {!loading && projects.length > 0 && visible.length === 0 && <div className="grid min-h-44 place-items-center rounded-2xl border border-dashed border-[#d9dfdd] bg-white text-center"><div><Icon icon="mdi:book-search-outline" className="mx-auto text-4xl text-[#a3aaa7]" /><p className="mt-2 text-sm text-[#7d8582]">没有找到匹配“{query}”的书目</p><button type="button" onClick={() => setQuery("")} className="mt-3 text-xs font-semibold text-brand-ink">清除搜索</button></div></div>}

        {!loading && visible.length > 0 && (
          <div className="flex snap-x gap-4 overflow-x-auto pb-3 [scrollbar-width:thin]">
            {visible.map((project, index) => {
              const checked = selected.includes(project.id);
              return (
                <article key={project.id} className={`group relative grid min-h-[218px] w-[310px] flex-none snap-start overflow-hidden rounded-2xl border bg-white shadow-sm transition ${checked ? "border-brand ring-2 ring-brand/10" : "border-[#e1e5e3] "}`}>
                  <div className={`h-2 ${index % 3 === 0 ? "bg-brand" : index % 3 === 1 ? "bg-[#557b95]" : "bg-[#8a7297]"}`} />
                  <div className="grid content-between p-5">
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" onClick={() => toggleSelected(project.id)} className={`grid h-5 w-5 shrink-0 place-items-center rounded border text-xs ${checked ? "border-brand bg-brand text-white" : "border-[#cfd5d3] text-transparent"}`} aria-label={`选择${project.title}`}><Icon icon="mdi:check" /></button>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${project.status === "active" ? "bg-brand-soft text-brand-ink" : "bg-[#f0f2f1] text-[#707875]"}`}>{project.status === "active" ? "创作中" : project.status}</span>
                      </div>
                      <button type="button" onClick={() => onOpenProject(project.id)} className="mt-4 block w-full text-left"><h3 className="truncate text-lg font-semibold text-[#202725]">{project.title}</h3><p className="mt-2 truncate text-sm text-[#6d7673]">{project.genre || "未设置题材"}</p></button>
                    </div>
                    <div className="mt-8 flex items-end justify-between gap-3 border-t border-[#edf0ef] pt-4">
                      <p className="text-[11px] leading-5 text-[#8b9390]">最近更新<br />{formatUpdate(project.updatedAt)}</p>
                      <div className="flex items-center gap-1"><button type="button" onClick={() => onDeleteProject(project)} className="grid h-8 w-8 place-items-center rounded-lg text-[#9ca29f] opacity-100 transition " aria-label={`删除${project.title}`}><Icon icon="mdi:trash-can-outline" /></button><button type="button" onClick={() => onOpenProject(project.id)} className="flex h-9 items-center gap-1 rounded-xl bg-[#f1f6f4] px-3 text-xs font-semibold text-brand-ink">进入工作台<Icon icon="mdi:arrow-right" /></button></div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
