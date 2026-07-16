import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  backfillNovelNarrativeAssets,
  createNovelBranch,
  createNovelCheckpoint,
  createNovelResource,
  createNovelStorylineMilestone,
  deleteNovelResource,
  getNovelNarrativeAssets,
  getNovelNarrativeDashboard,
  getNovelStructure,
  listNovelCheckpoints,
  listNovelCharacters,
  listNovelProps,
  listNovelStorylines,
  rollbackNovelCheckpoint,
  updateNovelResource,
  type NovelEditableResource,
  type NovelNarrativeAssets,
  type NovelNarrativeDashboard,
  type NovelStructureNode,
} from "../../api";
import { NovelPromptWorkbench } from "./NovelPromptWorkbench";
import { NovelScoreTrend } from "./NovelScoreTrend";

type WorkspaceTab = "overview" | "structure" | "storylines" | "timeline" | "foreshadows" | "props" | "causal" | "checkpoints";
type EditorKind = "structure" | "storylines" | "timeline" | "foreshadows" | "narrative-debts" | "props" | "milestone";
type EditorState = { kind: EditorKind; id: string; parentId: string; values: Record<string, string> };

const EMPTY_ASSETS: NovelNarrativeAssets = { timeline: [], foreshadows: [], debts: [], events: [], causalEdges: [], facts: [], foreshadowEvents: [] };
const TABS: readonly [WorkspaceTab, string, string][] = [
  ["overview", "叙事总览", "mdi:view-dashboard-outline"],
  ["structure", "部卷幕章", "mdi:file-tree-outline"],
  ["storylines", "故事线", "mdi:source-branch"],
  ["timeline", "时间线", "mdi:timeline-clock-outline"],
  ["foreshadows", "伏笔与债务", "mdi:lightbulb-on-outline"],
  ["props", "道具生命周期", "mdi:treasure-chest-outline"],
  ["causal", "知识与因果", "mdi:graph-outline"],
  ["checkpoints", "检查点", "mdi:source-commit"],
];
const PROP_STATUS_LABELS: Record<string, string> = { active: "使用中", lost: "遗失", destroyed: "损毁", retired: "退场" };
const PROP_EVENT_LABELS: Record<string, string> = { introduced: "首次出现", acquired: "获得", transferred: "转移", used: "使用", lost: "遗失", destroyed: "损毁", mentioned: "出现" };

function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function rows(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function listText(value: unknown): string { return Array.isArray(value) ? value.map(text).filter(Boolean).join("、") : text(value); }
function numberValue(value: string): number | null { const parsed = Number(value); return value.trim() && Number.isFinite(parsed) ? parsed : null; }
function splitList(value: string): string[] { return value.split(/[\n、,，]/u).map((item) => item.trim()).filter(Boolean); }

function fieldValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return Array.isArray(value) ? value.map(text).filter(Boolean).join("、") : text(value);
}

const EDITOR_TITLES: Record<EditorKind, string> = {
  structure: "结构节点",
  storylines: "故事线",
  timeline: "时间线事件",
  foreshadows: "伏笔",
  "narrative-debts": "叙事债务",
  props: "道具",
  milestone: "故事线里程碑",
};

function EditorField({ label, value, onChange, multiline = false, type = "text", options }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; type?: string; options?: readonly [string, string][] }) {
  return <label className="grid gap-1.5 text-xs font-semibold text-[#59635f]"><span>{label}</span>{options ? <select value={value} onChange={(event) => onChange(event.currentTarget.value)} className="h-10 rounded-xl border border-[#d9dfdd] bg-white px-3 text-sm font-normal outline-none focus:border-brand">{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : multiline ? <textarea value={value} onChange={(event) => onChange(event.currentTarget.value)} rows={4} className="resize-y rounded-xl border border-[#d9dfdd] bg-white p-3 text-sm font-normal leading-6 outline-none focus:border-brand" /> : <input value={value} onChange={(event) => onChange(event.currentTarget.value)} type={type} className="h-10 rounded-xl border border-[#d9dfdd] bg-white px-3 text-sm font-normal outline-none focus:border-brand" />}</label>;
}

function EditorDialog({ editor, structure, busy, error, onChange, onClose, onSave }: { editor: EditorState; structure: NovelStructureNode[]; busy: boolean; error: string; onChange: (key: string, value: string) => void; onClose: () => void; onSave: () => void }) {
  const v = editor.values;
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-[#101615]/55 p-3 backdrop-blur-sm"><section className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-[#f7f9f8] shadow-2xl [scrollbar-width:thin]"><header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#e1e6e4] bg-white px-5 py-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-ink">Narrative editor</p><h3 className="mt-1 text-lg font-semibold text-[#27312e]">{editor.id ? "编辑" : "新建"}{EDITOR_TITLES[editor.kind]}</h3></div><button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d9dfdd]"><Icon icon="mdi:close" /></button></header><div className="grid gap-4 p-5 sm:grid-cols-2">
    {editor.kind === "structure" && <><EditorField label="节点类型" value={v.nodeType ?? "chapter"} onChange={(value) => onChange("nodeType", value)} options={[["book", "全书"], ["volume", "卷"], ["act", "幕"], ["chapter", "章"]]} /><label className="grid gap-1.5 text-xs font-semibold text-[#59635f]"><span>父节点</span><select value={v.parentId ?? ""} onChange={(event) => onChange("parentId", event.currentTarget.value)} className="h-10 rounded-xl border border-[#d9dfdd] bg-white px-3 text-sm font-normal"><option value="">根节点</option>{structure.filter((node) => node.id !== editor.id && node.nodeType !== "chapter").map((node) => <option key={node.id} value={node.id}>{node.nodeType} · {node.title}</option>)}</select></label><EditorField label="标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /><EditorField label="排序编号" type="number" value={v.number ?? "1"} onChange={(value) => onChange("number", value)} /><EditorField label="开始章节" type="number" value={v.startChapter ?? ""} onChange={(value) => onChange("startChapter", value)} /><EditorField label="结束章节" type="number" value={v.endChapter ?? ""} onChange={(value) => onChange("endChapter", value)} /><div className="sm:col-span-2"><EditorField label="节点说明" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div><div className="sm:col-span-2"><EditorField label="规划大纲" value={v.outline ?? ""} onChange={(value) => onChange("outline", value)} multiline /></div></>}
    {editor.kind === "storylines" && <><EditorField label="标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /><EditorField label="线型" value={v.storylineType ?? "main"} onChange={(value) => onChange("storylineType", value)} options={[["main", "主线"], ["subplot", "支线"], ["hidden", "暗线"]]} /><EditorField label="状态" value={v.status ?? "active"} onChange={(value) => onChange("status", value)} options={[["active", "推进中"], ["resolved", "已完成"], ["paused", "暂停"]]} /><EditorField label="承诺标签（顿号分隔）" value={v.promiseTags ?? ""} onChange={(value) => onChange("promiseTags", value)} /><div className="sm:col-span-2"><EditorField label="叙事目标" value={v.goal ?? ""} onChange={(value) => onChange("goal", value)} multiline /></div><div className="sm:col-span-2"><EditorField label="核心冲突" value={v.conflict ?? ""} onChange={(value) => onChange("conflict", value)} multiline /></div></>}
    {editor.kind === "milestone" && <><EditorField label="章节" type="number" value={v.chapterNumber ?? "1"} onChange={(value) => onChange("chapterNumber", value)} /><EditorField label="状态" value={v.status ?? "planned"} onChange={(value) => onChange("status", value)} options={[["planned", "计划"], ["active", "进行中"], ["completed", "完成"], ["cancelled", "取消"]]} /><div className="sm:col-span-2"><EditorField label="标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /></div><div className="sm:col-span-2"><EditorField label="说明" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div></>}
    {editor.kind === "timeline" && <><EditorField label="时间标签" value={v.timeLabel ?? ""} onChange={(value) => onChange("timeLabel", value)} /><EditorField label="对应章节" type="number" value={v.chapterNumber ?? ""} onChange={(value) => onChange("chapterNumber", value)} /><div className="sm:col-span-2"><EditorField label="事件标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /></div><div className="sm:col-span-2"><EditorField label="事件说明" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div><div className="sm:col-span-2"><EditorField label="参与者（顿号分隔）" value={v.participants ?? ""} onChange={(value) => onChange("participants", value)} /></div></>}
    {editor.kind === "foreshadows" && <><EditorField label="伏笔标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /><EditorField label="状态" value={v.status ?? "open"} onChange={(value) => onChange("status", value)} options={[["open", "已埋设"], ["hinted", "已强化"], ["resolved", "已回收"], ["abandoned", "已放弃"]]} /><EditorField label="埋设章节" type="number" value={v.introducedInChapterIndex ?? ""} onChange={(value) => onChange("introducedInChapterIndex", value)} /><EditorField label="预计回收章" type="number" value={v.expectedPayoffChapter ?? "0"} onChange={(value) => onChange("expectedPayoffChapter", value)} /><EditorField label="关联人物" value={v.relatedCharacter ?? ""} onChange={(value) => onChange("relatedCharacter", value)} /><div className="sm:col-span-2"><EditorField label="伏笔说明" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div></>}
    {editor.kind === "narrative-debts" && <><EditorField label="债务标题" value={v.title ?? ""} onChange={(value) => onChange("title", value)} /><EditorField label="类型" value={v.debtType ?? "openThread"} onChange={(value) => onChange("debtType", value)} /><EditorField label="引入章节" type="number" value={v.introducedChapter ?? ""} onChange={(value) => onChange("introducedChapter", value)} /><EditorField label="到期章节" type="number" value={v.dueChapter ?? ""} onChange={(value) => onChange("dueChapter", value)} /><EditorField label="状态" value={v.status ?? "open"} onChange={(value) => onChange("status", value)} options={[["open", "待处理"], ["resolved", "已结清"], ["abandoned", "已放弃"]]} /><EditorField label="严重度" value={v.severity ?? "medium"} onChange={(value) => onChange("severity", value)} options={[["low", "低"], ["medium", "中"], ["high", "高"], ["critical", "严重"]]} /><div className="sm:col-span-2"><EditorField label="说明" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div></>}
    {editor.kind === "props" && <><EditorField label="道具名称" value={v.name ?? ""} onChange={(value) => onChange("name", value)} /><EditorField label="状态" value={v.status ?? "active"} onChange={(value) => onChange("status", value)} options={[["active", "使用中"], ["lost", "遗失"], ["destroyed", "损毁"], ["retired", "退场"]]} /><EditorField label="持有者" value={v.owner ?? ""} onChange={(value) => onChange("owner", value)} /><EditorField label="所在地点" value={v.location ?? ""} onChange={(value) => onChange("location", value)} /><div className="sm:col-span-2"><EditorField label="用途与规则" value={v.description ?? ""} onChange={(value) => onChange("description", value)} multiline /></div></>}
  </div>{error && <p className="mx-5 mb-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}<footer className="sticky bottom-0 flex justify-end gap-2 border-t border-[#e1e6e4] bg-white px-5 py-4"><button type="button" onClick={onClose} className="h-10 rounded-xl border border-[#d9dfdd] px-4 text-xs font-semibold">取消</button><button type="button" onClick={onSave} disabled={busy} className="h-10 rounded-xl bg-brand px-5 text-xs font-semibold text-white disabled:opacity-50">{busy ? "保存中" : "保存"}</button></footer></section></div>;
}

function ActionButtons({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"><button type="button" onClick={onEdit} className="grid h-7 w-7 place-items-center rounded-lg text-[#65706c] hover:bg-brand-soft hover:text-brand-ink" aria-label="编辑"><Icon icon="mdi:pencil-outline" /></button><button type="button" onClick={onDelete} className="grid h-7 w-7 place-items-center rounded-lg text-[#8a8f8d] hover:bg-red-50 hover:text-red-600" aria-label="删除"><Icon icon="mdi:trash-can-outline" /></button></div>;
}

export function NovelIntelligenceWorkspace({ token, projectId, showPrompts = true }: { readonly token: string; readonly projectId: string; readonly showPrompts?: boolean }) {
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [dashboard, setDashboard] = useState<NovelNarrativeDashboard | null>(null);
  const [structure, setStructure] = useState<NovelStructureNode[]>([]);
  const [characters, setCharacters] = useState<Array<Record<string, unknown>>>([]);
  const [relations, setRelations] = useState<Array<Record<string, unknown>>>([]);
  const [storylines, setStorylines] = useState<Array<Record<string, unknown>>>([]);
  const [props, setProps] = useState<Array<Record<string, unknown>>>([]);
  const [assets, setAssets] = useState<NovelNarrativeAssets>(EMPTY_ASSETS);
  const [checkpoints, setCheckpoints] = useState<Array<Record<string, unknown>>>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    const [nextDashboard, nextStructure, cast, nextStorylines, nextProps, nextAssets, nextCheckpoints] = await Promise.all([
      getNovelNarrativeDashboard(token, projectId), getNovelStructure(token, projectId), listNovelCharacters(token, projectId), listNovelStorylines(token, projectId), listNovelProps(token, projectId), getNovelNarrativeAssets(token, projectId), listNovelCheckpoints(token, projectId),
    ]);
    setDashboard(nextDashboard); setStructure(nextStructure); setCharacters(cast.characters); setRelations(cast.relations); setStorylines(nextStorylines); setProps(nextProps); setAssets(nextAssets); setCheckpoints(nextCheckpoints);
  }, [projectId, token]);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载叙事智能失败")); }, [load]);

  const openEditor = (kind: EditorKind, row: Record<string, unknown> = {}, parentId = "") => {
    const defaults: Record<EditorKind, Record<string, string>> = {
      structure: { nodeType: "chapter", title: "", description: "", number: String(structure.length + 1), parentId: "", startChapter: "", endChapter: "", outline: "" },
      storylines: { title: "", storylineType: "main", status: "active", goal: "", conflict: "", promiseTags: "" },
      milestone: { chapterNumber: "1", title: "", description: "", status: "planned" },
      timeline: { chapterNumber: "", timeLabel: "", title: "", description: "", participants: "" },
      foreshadows: { introducedInChapterIndex: "", title: "", description: "", expectedPayoffChapter: "0", status: "open", relatedCharacter: "" },
      "narrative-debts": { debtType: "openThread", title: "", description: "", introducedChapter: "", dueChapter: "", status: "open", severity: "medium" },
      props: { name: "", description: "", owner: "", location: "", status: "active" },
    };
    const values = { ...defaults[kind] };
    for (const key of Object.keys(values)) values[key] = fieldValue(row, key) || values[key]!;
    setEditor({ kind, id: text(row.id), parentId, values }); setError("");
  };
  const updateEditor = (key: string, value: string) => setEditor((current) => current ? { ...current, values: { ...current.values, [key]: value } } : current);

  const saveEditor = async () => {
    if (!editor) return;
    const v = editor.values;
    let resource: NovelEditableResource = editor.kind === "milestone" ? "storyline-milestones" : editor.kind;
    let payload: Record<string, unknown>;
    if (editor.kind === "structure") payload = { parentId: v.parentId || null, nodeType: v.nodeType, title: v.title, description: v.description, number: numberValue(v.number) ?? 1, startChapter: numberValue(v.startChapter), endChapter: numberValue(v.endChapter), outline: v.outline, metadata: {} };
    else if (editor.kind === "storylines") payload = { title: v.title, storylineType: v.storylineType, status: v.status, goal: v.goal, conflict: v.conflict, promiseTags: splitList(v.promiseTags), aliases: [] };
    else if (editor.kind === "milestone") payload = { chapterNumber: numberValue(v.chapterNumber) ?? 1, title: v.title, description: v.description, status: v.status };
    else if (editor.kind === "timeline") payload = { chapterNumber: numberValue(v.chapterNumber), timeLabel: v.timeLabel, title: v.title, description: v.description, participants: splitList(v.participants) };
    else if (editor.kind === "foreshadows") payload = { introducedInChapterIndex: numberValue(v.introducedInChapterIndex), title: v.title, description: v.description, expectedPayoffChapter: numberValue(v.expectedPayoffChapter) ?? 0, status: v.status, relatedCharacter: v.relatedCharacter };
    else if (editor.kind === "narrative-debts") payload = { debtType: v.debtType, title: v.title, description: v.description, introducedChapter: numberValue(v.introducedChapter), dueChapter: numberValue(v.dueChapter), status: v.status, severity: v.severity };
    else payload = { name: v.name, description: v.description, owner: v.owner, location: v.location, status: v.status, metadata: {} };
    setBusy(true); setError("");
    try {
      if (editor.kind === "milestone" && !editor.id) await createNovelStorylineMilestone(token, projectId, editor.parentId, payload);
      else if (editor.id) await updateNovelResource(token, projectId, resource, editor.id, payload);
      else await createNovelResource(token, projectId, resource, payload);
      setEditor(null); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const remove = async (resource: NovelEditableResource, id: string, name: string) => {
    if (!window.confirm(`确定删除“${name}”吗？`)) return;
    setBusy(true); setError("");
    try { await deleteNovelResource(token, projectId, resource, id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
    finally { setBusy(false); }
  };

  const backfillContinuity = async () => {
    setBackfilling(true); setError(""); setNotice("");
    try {
      const result = await backfillNovelNarrativeAssets(token, projectId);
      await load();
      setNotice(`已扫描 ${result.chapters} 章并重算 ${result.rescoredChapters} 章评分；当前 ${result.foreshadows} 条伏笔、${result.foreshadowEvents} 条伏笔事件、${result.debts} 项债务，另生成 ${result.timelineEvents} 条时间线、${result.props} 个道具。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "补齐叙事资产失败"); }
    finally { setBackfilling(false); }
  };

  const cards = useMemo(() => [
    ["角色与关系", characters.length, `${relations.length} 条关系`, "mdi:account-group-outline"],
    ["故事线", storylines.length, `${assets.debts.filter((item) => text(item.status) === "open").length} 项叙事债务`, "mdi:source-branch"],
    ["知识事实", assets.facts.length, `${assets.foreshadows.filter((item) => text(item.status) !== "resolved").length} 条开放伏笔`, "mdi:graph-outline"],
    ["道具", props.length, "生命周期追踪", "mdi:treasure-chest-outline"],
    ["检查点", checkpoints.length, "支持分支与回滚", "mdi:source-commit"],
  ] as const, [assets, characters.length, checkpoints.length, props.length, relations.length, storylines.length]);

  const createCheckpoint = async () => { setBusy(true); try { await createNovelCheckpoint(token, projectId, `手动检查点 ${new Date().toLocaleString("zh-CN")}`); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建检查点失败"); } finally { setBusy(false); } };
  const rollback = async (id: string) => { if (!window.confirm("恢复后当前作品状态会被替换，确定继续吗？")) return; setBusy(true); try { await rollbackNovelCheckpoint(token, projectId, id); window.location.reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "回滚失败"); setBusy(false); } };
  const branch = async (id: string) => { const name = window.prompt("输入新世界线名称"); if (!name?.trim()) return; setBusy(true); try { await createNovelBranch(token, projectId, id, name.trim()); window.location.reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建世界线失败"); setBusy(false); } };

  return <section className="grid gap-4">
    <header className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-ink">Narrative Intelligence</p><div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold text-[#27312e]">叙事智能中心</h2><p className="mt-1 text-sm text-[#6d7773]">直接治理故事树、人物关系、时间、伏笔、道具、知识与因果。</p></div><span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">{dashboard?.project.currentBranch || "main"} 世界线</span></div>{error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}{notice && <p className="mt-4 rounded-xl bg-brand-soft px-3 py-2 text-xs text-brand-ink">{notice}</p>}<nav className="mt-5 flex gap-1 overflow-x-auto rounded-xl bg-[#f1f4f3] p-1 [scrollbar-width:none]">{TABS.map(([id, label, icon]) => <button key={id} type="button" onClick={() => setTab(id)} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${tab === id ? "bg-white text-brand-ink shadow-sm" : "text-[#69736f]"}`}><Icon icon={icon} />{label}</button>)}</nav></header>

    {tab === "overview" && <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{cards.map(([label, value, hint, icon]) => <article key={label} className="rounded-2xl border border-[#e1e6e4] bg-white p-4"><Icon icon={icon} className="text-xl text-brand-ink" /><p className="mt-3 text-xs font-semibold text-[#818a87]">{label}</p><p className="mt-1 text-2xl font-semibold text-[#27312e]">{value}</p><p className="mt-1 text-xs text-[#69736f]">{hint}</p></article>)}</div><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><h3 className="text-sm font-semibold">张力与质量趋势</h3><div className="mt-4"><NovelScoreTrend compact rows={dashboard?.tensionCurve ?? []} /></div></section></>}

    {tab === "structure" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">部 · 卷 · 幕 · 章故事树</h3><p className="mt-1 text-xs text-[#7a8380]">编号决定同级顺序；编辑节点可调整父级和章节范围。</p></div><button type="button" onClick={() => openEditor("structure")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white"><Icon icon="mdi:plus" className="mr-1 inline" />新建节点</button></div><div className="mt-4 grid gap-2">{structure.map((node) => <article key={node.id} className="group flex items-start gap-3 rounded-xl border border-[#e5e9e7] p-3" style={{ marginLeft: node.nodeType === "volume" ? 12 : node.nodeType === "act" ? 28 : node.nodeType === "chapter" ? 44 : 0 }}><span className="mt-0.5 rounded-md bg-[#eef2f0] px-2 py-1 text-[10px] font-bold uppercase text-brand-ink">{node.nodeType}</span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{node.number}. {node.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-[#68726e]">{node.outline || node.description || "暂无规划"}</p></div><ActionButtons onEdit={() => openEditor("structure", node as unknown as Record<string, unknown>)} onDelete={() => void remove("structure", node.id, node.title)} /></article>)}{!structure.length && <p className="py-14 text-center text-sm text-[#89928f]">暂无结构节点</p>}</div></section>}

    {tab === "storylines" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">主线 · 支线 · 暗线</h3><p className="mt-1 text-xs text-[#7a8380]">里程碑定义各故事线在具体章节的汇流与兑现。</p></div><button type="button" onClick={() => openEditor("storylines")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white"><Icon icon="mdi:plus" className="mr-1 inline" />新建故事线</button></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{storylines.map((line) => <article key={text(line.id)} className="group rounded-2xl border border-[#e3e8e6] p-4"><div className="flex items-start justify-between gap-3"><div><span className="rounded-full bg-brand-soft px-2 py-1 text-[10px] font-semibold text-brand-ink">{({ main: "主线", subplot: "支线", hidden: "暗线" } as Record<string, string>)[text(line.storylineType)] ?? text(line.storylineType)}</span><h4 className="mt-2 font-semibold">{text(line.title)}</h4></div><ActionButtons onEdit={() => openEditor("storylines", line)} onDelete={() => void remove("storylines", text(line.id), text(line.title))} /></div><p className="mt-3 text-xs leading-5 text-[#616c68]">目标：{text(line.goal) || "待补充"}</p><p className="mt-1 text-xs leading-5 text-[#616c68]">冲突：{text(line.conflict) || "待补充"}</p><div className="mt-4 border-t border-[#edf0ef] pt-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-[#8a9390]">里程碑</span><button type="button" onClick={() => openEditor("milestone", {}, text(line.id))} className="text-xs font-semibold text-brand-ink">+ 添加</button></div><div className="mt-2 grid gap-2">{rows(line.milestones).map((milestone) => <div key={text(milestone.id)} className="group/m flex items-center gap-2 rounded-lg bg-[#f5f7f6] px-3 py-2"><span className="text-[10px] font-bold text-brand-ink">第{text(milestone.chapterNumber)}章</span><span className="min-w-0 flex-1 truncate text-xs">{text(milestone.title)}</span><ActionButtons onEdit={() => openEditor("milestone", milestone, text(line.id))} onDelete={() => void remove("storyline-milestones", text(milestone.id), text(milestone.title))} /></div>)}</div></div></article>)}{!storylines.length && <p className="py-14 text-center text-sm text-[#89928f] lg:col-span-2">暂无故事线</p>}</div></section>}

    {tab === "timeline" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">世界时间线</h3><p className="mt-1 text-xs text-[#7a8380]">同时记录世界内时间与对应章节，防止时序漂移。</p></div><div className="flex gap-2"><button type="button" onClick={() => void backfillContinuity()} disabled={backfilling} className="flex h-9 items-center gap-1.5 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink disabled:opacity-50"><Icon icon={backfilling ? "mdi:loading" : "mdi:text-search"} className={backfilling ? "animate-spin" : ""} />{backfilling ? "扫描中" : "从正文补齐"}</button><button type="button" onClick={() => openEditor("timeline")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white">+ 添加事件</button></div></div><div className="relative mt-5 grid gap-3 before:absolute before:bottom-4 before:left-[76px] before:top-4 before:w-px before:bg-brand/25">{assets.timeline.map((item) => <article key={text(item.id)} className="group relative grid grid-cols-[64px_12px_minmax(0,1fr)] items-start gap-2"><span className="pt-3 text-right text-[10px] font-semibold text-brand-ink">{text(item.timeLabel) || `第${text(item.chapterNumber) || "-"}章`}</span><span className="z-10 mt-3 h-3 w-3 rounded-full border-2 border-brand bg-white" /><div className="rounded-xl border border-[#e3e8e6] p-3"><div className="flex justify-between gap-3"><div><h4 className="text-sm font-semibold">{text(item.title)}</h4><p className="mt-1 text-[10px] text-[#89928f]">对应第 {text(item.chapterNumber) || "-"} 章 · {listText(item.participants) || "无指定参与者"}</p></div><ActionButtons onEdit={() => openEditor("timeline", item)} onDelete={() => void remove("timeline", text(item.id), text(item.title))} /></div><p className="mt-2 text-xs leading-5 text-[#65706c]">{text(item.description)}</p></div></article>)}{!assets.timeline.length && <p className="py-14 text-center text-sm text-[#89928f]">暂无时间线事件，可从现有章节正文自动补齐</p>}</div></section>}

    {tab === "foreshadows" && <div className="grid gap-4 xl:grid-cols-2"><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold">伏笔账本</h3><p className="mt-1 text-xs text-[#7a8380]">埋设、强化、回收全程追踪。</p></div><div className="flex gap-2"><button type="button" onClick={() => void backfillContinuity()} disabled={backfilling} className="h-9 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink disabled:opacity-50">{backfilling ? "重建中" : "从正文重建"}</button><button type="button" onClick={() => openEditor("foreshadows")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white">+ 新伏笔</button></div></div><div className="mt-4 grid gap-2">{assets.foreshadows.map((item) => { const overdue = ["open", "hinted"].includes(text(item.status)) && Number(item.expectedPayoffChapter) > 0 && Number(item.expectedPayoffChapter) < (dashboard?.stats.chapters ?? 0); return <article key={text(item.id)} className="group rounded-xl border border-[#e3e8e6] p-3"><div className="flex justify-between gap-3"><div><span className={`text-[10px] font-semibold ${overdue ? "text-red-600" : "text-brand-ink"}`}>{overdue ? "overdue" : text(item.status)} · 第{text(item.introducedInChapterIndex) || "-"}章 → 第{text(item.expectedPayoffChapter) || "?"}章</span><h4 className="mt-1 text-sm font-semibold">{text(item.title)}</h4></div><ActionButtons onEdit={() => openEditor("foreshadows", item)} onDelete={() => void remove("foreshadows", text(item.id), text(item.title))} /></div><p className="mt-2 text-xs leading-5 text-[#65706c]">{text(item.description)}</p><div className="mt-2 grid gap-1 border-t border-[#edf0ef] pt-2">{rows(item.events).map((event) => <p key={text(event.id)} className="text-[10px] text-[#7a8380]">第{text(event.chapterIndex)}章 · {({ planted: "埋设", reinforced: "强化", paidOff: "回收" } as Record<string, string>)[text(event.action)] ?? text(event.action)} · {text(event.evidence)}</p>)}</div></article>; })}{!assets.foreshadows.length && <p className="py-12 text-center text-sm text-[#89928f]">暂无伏笔</p>}</div></section><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">叙事债务</h3><p className="mt-1 text-xs text-[#7a8380]">未回答问题、未兑现承诺和连续性风险。</p></div><button type="button" onClick={() => openEditor("narrative-debts")} className="h-9 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink">+ 新债务</button></div><div className="mt-4 grid gap-2">{assets.debts.map((item) => { const overdue = text(item.status) === "open" && Number(item.dueChapter) > 0 && Number(item.dueChapter) < (dashboard?.stats.chapters ?? 0); return <article key={text(item.id)} className="group rounded-xl border border-[#e3e8e6] p-3"><div className="flex justify-between gap-3"><div><span className={`text-[10px] font-semibold ${overdue || text(item.severity) === "critical" || text(item.severity) === "high" ? "text-red-600" : "text-amber-600"}`}>{text(item.severity)} · {overdue ? "overdue" : text(item.status)} · 到期第{text(item.dueChapter) || "?"}章</span><h4 className="mt-1 text-sm font-semibold">{text(item.title)}</h4></div><ActionButtons onEdit={() => openEditor("narrative-debts", item)} onDelete={() => void remove("narrative-debts", text(item.id), text(item.title))} /></div><p className="mt-2 text-xs leading-5 text-[#65706c]">{text(item.description)}</p>{text(item.resolutionEvidence) && <p className="mt-2 rounded-lg bg-emerald-50 p-2 text-[10px] text-emerald-700">第{text(item.resolvedInChapter)}章解决：{text(item.resolutionEvidence)}</p>}</article>; })}{!assets.debts.length && <p className="py-12 text-center text-sm text-[#89928f]">暂无叙事债务</p>}</div></section></div>}

    {tab === "props" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">道具生命周期</h3><p className="mt-1 text-xs text-[#7a8380]">追踪持有者、位置、状态与章内变化。</p></div><div className="flex gap-2"><button type="button" onClick={() => void backfillContinuity()} disabled={backfilling} className="flex h-9 items-center gap-1.5 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink disabled:opacity-50"><Icon icon={backfilling ? "mdi:loading" : "mdi:text-search"} className={backfilling ? "animate-spin" : ""} />{backfilling ? "扫描中" : "从正文补齐"}</button><button type="button" onClick={() => openEditor("props")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white">+ 新道具</button></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{props.map((item) => <article key={text(item.id)} className="group rounded-2xl border border-[#e3e8e6] p-4"><div className="flex justify-between gap-3"><Icon icon="mdi:treasure-chest-outline" className="text-2xl text-brand-ink" /><ActionButtons onEdit={() => openEditor("props", item)} onDelete={() => void remove("props", text(item.id), text(item.name))} /></div><h4 className="mt-2 font-semibold">{text(item.name)}</h4><p className="mt-1 text-[10px] font-semibold text-brand-ink">{PROP_STATUS_LABELS[text(item.status)] ?? text(item.status)} · {text(item.owner) || "无持有者"} · {text(item.location) || "位置未知"}</p><p className="mt-3 text-xs leading-5 text-[#65706c]">{text(item.description)}</p><div className="mt-3 grid gap-1 border-t border-[#edf0ef] pt-2">{rows(item.events).slice(0, 4).map((event) => <p key={text(event.id)} className="text-[10px] text-[#7a8380]">第{text(event.chapterNumber) || "-"}章 · {PROP_EVENT_LABELS[text(event.eventType)] ?? text(event.eventType)} · {text(event.description)}</p>)}</div></article>)}{!props.length && <p className="py-14 text-center text-sm text-[#89928f] sm:col-span-2 xl:col-span-3">暂无道具，可从现有章节正文自动补齐</p>}</div></section>}

    {tab === "causal" && <div className="grid gap-4 xl:grid-cols-2"><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><h3 className="font-semibold">知识图谱事实</h3><div className="mt-4 grid gap-2">{assets.facts.slice(0, 80).map((fact) => <div key={text(fact.id)} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl bg-[#f5f7f6] p-3 text-xs"><span className="font-semibold">{text(fact.subject)}</span><span className="rounded-full bg-white px-2 py-1 text-[10px] text-brand-ink">{text(fact.predicate)}</span><span className="text-right">{text(fact.object)}</span></div>)}{!assets.facts.length && <p className="py-12 text-center text-sm text-[#89928f]">章后分析会生成稳定事实</p>}</div></section><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><h3 className="font-semibold">事件因果链</h3><div className="mt-4 grid gap-3">{assets.events.map((event) => <article key={text(event.id)} className="rounded-xl border border-[#e3e8e6] p-3"><div className="flex items-center gap-2"><span className="rounded bg-brand-soft px-2 py-1 text-[10px] font-semibold text-brand-ink">第{text(event.chapterNumber)}章</span><h4 className="text-sm font-semibold">{text(event.title)}</h4></div><p className="mt-2 text-xs text-[#65706c]">{text(event.description)}</p><div className="mt-2 flex flex-wrap gap-1">{assets.causalEdges.filter((edge) => text(edge.fromEventId) === text(event.id)).map((edge) => <span key={text(edge.id)} className="rounded-full bg-[#eef2f0] px-2 py-1 text-[10px] text-[#59635f]">{text(edge.relationType)} → {text(edge.toEventId).slice(-6)}</span>)}</div></article>)}{!assets.events.length && <p className="py-12 text-center text-sm text-[#89928f]">章后同步会生成事件与因果关系</p>}</div></section></div>}

    {tab === "checkpoints" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">检查点与世界线</h3><p className="mt-1 text-xs text-[#7a8380]">每次生成前自动保存，也可手动创建、回滚和分支。</p></div><button type="button" onClick={() => void createCheckpoint()} disabled={busy} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white disabled:opacity-50">创建检查点</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{checkpoints.map((item) => <article key={text(item.id)} className="rounded-2xl border border-[#e3e8e6] p-4"><div className="flex justify-between"><h4 className="text-sm font-semibold">{text(item.label) || "检查点"}</h4>{Boolean(item.isHead) && <span className="rounded-full bg-brand-soft px-2 py-1 text-[9px] font-semibold text-brand-ink">HEAD</span>}</div><p className="mt-2 text-xs text-[#7a8380]">{text(item.branchName)} · 第{text(item.chapterNumber) || "-"}章</p><div className="mt-4 flex gap-3">{!item.isHead && <button type="button" onClick={() => void rollback(text(item.id))} className="text-xs font-semibold text-red-600">回滚</button>}<button type="button" onClick={() => void branch(text(item.id))} className="text-xs font-semibold text-brand-ink">从这里分支</button></div></article>)}</div></section>}
    {showPrompts && <NovelPromptWorkbench token={token} projectId={projectId} />}
    {editor && <EditorDialog editor={editor} structure={structure} busy={busy} error={error} onChange={updateEditor} onClose={() => setEditor(null)} onSave={() => void saveEditor()} />}
  </section>;
}
