import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { NovelProjectSummary } from "../../novelApi";
import { cx } from "../ui";
import { WF_PANEL, WF_SHELL_FORM } from "../workflow/workflowLayout";
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
    <section className={WF_SHELL_FORM}>
      <div className="min-w-0 flex-1 xl:min-h-0 xl:overflow-y-auto xl:pb-8">
        {/* B 形态：设置主导居中，单列 768px（Tailwind 原生刻度）。
            原来这里还有一行 `h1`「长篇叙事工作台」压在卡片上方 —— 模块名归顶栏的模块胶囊，
            屏幕自己的名字由卡片头「创建新作品」承担（原型里也是这么排的）。
            一行 80 字上下，比占满 880px 的 100+ 字好读。 */}
        <div className="mx-auto w-full max-w-3xl">
          <NovelCreatePage draft={draft} isSubmitting={isCreating} onChange={onDraftChange} onSubmit={onCreate} />
          {error && <p className="mt-4 rounded-[10px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger-ink">{error}</p>}
        </div>
      </div>

      {/* 右=历史。原来书目长在表单**下面**（横向卡片轮播），现在是右栏的条目列表 ——
          统一规范 v2：左=设置、中=工作区、右=历史；小说创建没有左栏，设置居中。 */}
      <aside
        className={cx(WF_PANEL, "xl:h-full")}
        aria-label="书目历史"
      >
        <div className="flex min-h-14 flex-none items-center justify-between gap-2 border-b border-hairline-subtle px-3 py-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">历史</h2>
            <p className="mt-0.5 text-xs text-ink-tertiary">{projects.length} 本书目</p>
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={removeSelected}
              className="h-8 flex-none rounded-[10px] border border-danger/30 bg-surface px-2.5 text-xs font-semibold text-danger-ink"
            >
              删除选中 ({selected.length})
            </button>
          )}
        </div>

        <div className="flex-none px-3 py-2">
          <label className="flex h-10 items-center gap-2 rounded-[10px] border border-hairline bg-surface-subtle px-3 text-sm text-ink-secondary focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/10">
            <Icon icon="mdi:magnify" aria-hidden />
            <span className="sr-only">搜索书目</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索书名或类型"
              className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm text-ink outline-none shadow-none focus:border-0 focus:shadow-none"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="清除搜索">
                <Icon icon="mdi:close-circle" />
              </button>
            )}
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
          {loading && (
            <p className="px-2 py-5 text-center text-xs text-ink-secondary">
              <Icon icon="mdi:loading" className="mx-auto mb-1 block animate-spin text-lg text-brand-ink" aria-hidden />
              加载书目中
            </p>
          )}

          {!loading && projects.length === 0 && (
            <p className="grid min-h-40 place-items-center rounded-[10px] border border-dashed border-hairline bg-surface-subtle px-4 text-center text-xs leading-5 text-ink-tertiary">
              还没有书目，在左边写下故事创意，创建第一本书
            </p>
          )}

          {!loading && projects.length > 0 && visible.length === 0 && (
            <p className="px-2 py-5 text-center text-xs leading-5 text-ink-tertiary">
              没有找到匹配「{query}」的书目
              <button type="button" onClick={() => setQuery("")} className="ml-2 font-semibold text-brand-ink">清除搜索</button>
            </p>
          )}

          {!loading && visible.map((project) => {
            const checked = selected.includes(project.id);
            return (
              <div
                key={project.id}
                className={cx(
                  "group flex items-center gap-2 rounded-[10px] border p-1.5 transition",
                  checked ? "border-brand/40 bg-brand-soft" : "border-transparent hover:bg-surface-subtle",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleSelected(project.id)}
                  aria-label={`选择${project.title}`}
                  aria-pressed={checked}
                  className={cx(
                    "grid size-5 flex-none place-items-center rounded-full border text-xs",
                    checked ? "border-brand bg-brand text-white" : "border-hairline text-transparent",
                  )}
                >
                  <Icon icon="mdi:check" aria-hidden />
                </button>

                <button
                  type="button"
                  onClick={() => onOpenProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span aria-hidden className="grid size-9 flex-none place-items-center rounded-[10px] bg-brand-soft text-sm font-semibold text-brand-ink">
                    {project.title.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{project.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-xs text-ink-tertiary">{project.genre || "未设置题材"} · {formatUpdate(project.updatedAt)}</span>
                      <span className={cx(
                        "flex-none rounded-full px-2 py-0.5 text-xs font-semibold",
                        project.status === "active" ? "bg-brand-soft text-brand-ink" : "bg-surface-muted text-ink-secondary",
                      )}>
                        {project.status === "active" ? "创作中" : project.status}
                      </span>
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => onDeleteProject(project)}
                  aria-label={`删除${project.title}`}
                  className="grid size-8 flex-none place-items-center rounded-[10px] text-ink-tertiary transition hover:bg-danger/10 hover:text-danger-ink"
                >
                  <Icon icon="mdi:trash-can-outline" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </section>
  );
}
