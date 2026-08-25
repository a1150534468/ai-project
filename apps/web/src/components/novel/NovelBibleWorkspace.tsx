import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  createNovelCharacterRelation,
  createNovelResource,
  deleteNovelResource,
  getNovelSetup,
  updateNovelResource,
  type NovelSetupPayload,
} from "../../api";

type BibleTab = "world" | "characters" | "locations";
type AssetEditor = { kind: "characters" | "locations"; id: string; values: Record<string, string> };

function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function AssetField({ label, value, onChange, multiline = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean }) {
  return <label className="grid gap-1.5 text-xs font-semibold text-[#59635f]"><span>{label}</span>{multiline ? <textarea value={value} onChange={(event) => onChange(event.currentTarget.value)} rows={4} className="resize-y rounded-xl border border-[#d9dfdd] bg-white p-3 text-sm font-normal leading-6 outline-none focus:border-brand" /> : <input value={value} onChange={(event) => onChange(event.currentTarget.value)} className="h-10 rounded-xl border border-[#d9dfdd] bg-white px-3 text-sm font-normal outline-none focus:border-brand" />}</label>;
}

export function NovelBibleWorkspace({ token, projectId, onOpenSetup }: { readonly token: string; readonly projectId: string; readonly onOpenSetup: () => void }) {
  const [setup, setSetup] = useState<NovelSetupPayload | null>(null);
  const [tab, setTab] = useState<BibleTab>("world");
  const [editor, setEditor] = useState<AssetEditor | null>(null);
  const [relationOpen, setRelationOpen] = useState(false);
  const [relation, setRelation] = useState({ fromCharacterId: "", toCharacterId: "", relationType: "盟友", description: "", strength: "0.5" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => getNovelSetup(token, projectId).then(setSetup), [projectId, token]);
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载 Bible 失败")); }, [load]);
  const bible = record(setup?.bible);
  const dimensions = Array.isArray(bible.worldDimensions) ? bible.worldDimensions.map(record) : [];
  const styles = Array.isArray(bible.styleNotes) ? bible.styleNotes.map(record) : [];
  const characters = setup?.characters ?? [];
  const locations = setup?.locations ?? [];
  const names = useMemo(() => new Map(characters.map((item) => [text(item.id), text(item.name)])), [characters]);

  const openAsset = (kind: AssetEditor["kind"], row: Record<string, unknown> = {}) => {
    const defaults: Record<string, string> = kind === "characters"
      ? { name: "", role: "", gender: "", age: "", description: "", appearance: "", personality: "", publicProfile: "", coreBelief: "", coreMotivation: "", innerLack: "", voiceStyle: "" }
      : { name: "", description: "", rules: "" };
    const values = { ...defaults };
    for (const key of Object.keys(values)) values[key] = text(row[key]);
    setEditor({ kind, id: text(row.id), values }); setError("");
  };

  const saveAsset = async () => {
    if (!editor) return;
    if (!editor.values.name.trim()) { setError("名称不能为空"); return; }
    setBusy(true); setError("");
    try {
      const payload = editor.kind === "characters"
        ? { ...editor.values, moralTaboos: [], state: {} }
        : { ...editor.values, metadata: {} };
      if (editor.id) await updateNovelResource(token, projectId, editor.kind, editor.id, payload);
      else await createNovelResource(token, projectId, editor.kind, payload);
      setEditor(null); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const removeAsset = async (kind: "characters" | "locations" | "character-relations", id: string, label: string) => {
    if (!window.confirm(`确定删除“${label}”吗？`)) return;
    setBusy(true); setError("");
    try { await deleteNovelResource(token, projectId, kind, id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
    finally { setBusy(false); }
  };

  const saveRelation = async () => {
    if (!relation.fromCharacterId || !relation.toCharacterId || relation.fromCharacterId === relation.toCharacterId) { setError("请选择两个不同的人物"); return; }
    setBusy(true); setError("");
    try {
      await createNovelCharacterRelation(token, projectId, { ...relation, strength: Math.max(0, Math.min(1, Number(relation.strength) || 0.5)) });
      setRelationOpen(false); setRelation({ fromCharacterId: "", toCharacterId: "", relationType: "盟友", description: "", strength: "0.5" }); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存人物关系失败"); }
    finally { setBusy(false); }
  };

  return <section className="grid gap-4 p-4 sm:p-6">
    <header className="flex flex-col gap-3 rounded-2xl border border-[#e1e6e4] bg-white p-5 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-ink">Story Bible</p><h2 className="mt-1 text-xl font-semibold text-ink">作品设定中枢</h2><p className="mt-1 text-sm text-[#6d7773]">世界五维、文风公约、人物心理锚点和地点规则共同构成生成硬约束。</p></div><button type="button" onClick={onOpenSetup} className="h-9 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink"><Icon icon="mdi:tune-variant" className="mr-1 inline" />编辑 Bible 与世界观</button></header>
    {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    <nav className="flex gap-2 overflow-x-auto rounded-xl border border-[#e1e6e4] bg-white p-2 [scrollbar-width:none]">{([["world", "世界与文风", "mdi:earth"], ["characters", "人物与关系", "mdi:account-group-outline"], ["locations", "地点系统", "mdi:map-outline"]] as const).map(([id, label, icon]) => <button key={id} type="button" onClick={() => setTab(id)} className={`flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${tab === id ? "bg-brand-soft text-brand-ink" : "text-[#69736f]"}`}><Icon icon={icon} />{label}</button>)}</nav>

    {tab === "world" && <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,.7fr)]"><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex justify-between"><div><h3 className="text-sm font-semibold text-ink">世界观五维框架</h3><p className="mt-1 text-xs text-[#89928f]">核心法则、地理生态、社会结构、历史文化、日常生活</p></div><button type="button" onClick={onOpenSetup} className="text-xs font-semibold text-brand-ink">编辑</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{dimensions.map((item, index) => <article key={text(item.id) || index} className="rounded-xl border border-[#e5eae8] bg-[#fafbfb] p-4"><p className="text-xs font-semibold text-brand-ink">{text(item.title)}</p><p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-[#606b67]">{text(item.summary) || JSON.stringify(item.details, null, 2)}</p></article>)}{!dimensions.length && <p className="py-12 text-center text-sm text-[#89928f] sm:col-span-2">设置向导生成后显示五维世界观</p>}</div></section><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex justify-between"><h3 className="text-sm font-semibold text-ink">文风公约</h3><button type="button" onClick={onOpenSetup} className="text-xs font-semibold text-brand-ink">编辑</button></div><div className="mt-4 grid gap-3">{styles.map((item, index) => <article key={text(item.id) || index} className="rounded-xl bg-[#f4f7f5] p-3"><p className="text-xs font-semibold text-ink">{text(item.title)}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#66716d]">{text(item.content)}</p></article>)}{!styles.length && <p className="py-10 text-center text-xs text-[#89928f]">暂无文风公约</p>}</div></section></div>}

    {tab === "characters" && <div className="grid gap-4"><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">人物心理锚点</h3><p className="mt-1 text-xs text-[#89928f]">身份、信念、动机、缺口、禁区、声线和当前状态。</p></div><button type="button" onClick={() => openAsset("characters")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white">+ 新建人物</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{characters.map((item, index) => <article key={text(item.id) || index} className="group rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-base font-semibold text-brand-ink">{text(item.name).slice(0, 1)}</span><div><h3 className="text-sm font-semibold text-ink">{text(item.name)}</h3><p className="mt-0.5 text-xs text-brand-ink">{text(item.role)}</p></div></div><div className="flex gap-1"><button type="button" onClick={() => openAsset("characters", item)} className="grid h-8 w-8 place-items-center rounded-lg text-[#66716d] "><Icon icon="mdi:pencil-outline" /></button><button type="button" onClick={() => void removeAsset("characters", text(item.id), text(item.name))} className="grid h-8 w-8 place-items-center rounded-lg text-[#8a9390] "><Icon icon="mdi:trash-can-outline" /></button></div></div><div className="mt-4 grid gap-2 text-xs leading-5 text-[#65706c]"><p><span className="font-semibold text-[#424d49]">核心信念：</span>{text(item.coreBelief) || "待补充"}</p><p><span className="font-semibold text-[#424d49]">核心动机：</span>{text(item.coreMotivation) || "待补充"}</p><p><span className="font-semibold text-[#424d49]">内在缺口：</span>{text(item.innerLack) || "待补充"}</p><p><span className="font-semibold text-[#424d49]">声线：</span>{text(item.voiceStyle) || "待补充"}</p></div></article>)}</div></section><section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">人物关系图谱</h3><p className="mt-1 text-xs text-[#89928f]">关系会进入章节上下文并随章后状态更新。</p></div><button type="button" onClick={() => setRelationOpen(true)} className="h-9 rounded-xl border border-brand/30 px-3 text-xs font-semibold text-brand-ink">+ 新建关系</button></div><div className="mt-4 flex flex-wrap gap-2">{(setup?.relations ?? []).map((item) => <div key={text(item.id)} className="group flex items-center gap-2 rounded-full border border-[#dfe5e2] bg-[#f7f9f8] px-3 py-2 text-xs"><span className="font-semibold">{names.get(text(item.fromCharacterId)) || "?"}</span><span className="text-brand-ink">— {text(item.relationType)} →</span><span className="font-semibold">{names.get(text(item.toCharacterId)) || "?"}</span><button type="button" onClick={() => void removeAsset("character-relations", text(item.id), text(item.relationType))} className="ml-1 text-[#9aa19f] "><Icon icon="mdi:close" /></button></div>)}{!setup?.relations.length && <p className="py-8 text-sm text-[#89928f]">暂无人物关系</p>}</div></section></div>}

    {tab === "locations" && <section className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">地点与场景规则</h3><p className="mt-1 text-xs text-[#89928f]">地点规则、空间风险和叙事用途会约束场景生成。</p></div><button type="button" onClick={() => openAsset("locations")} className="h-9 rounded-xl bg-brand px-3 text-xs font-semibold text-white">+ 新建地点</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{locations.map((item, index) => <article key={text(item.id) || index} className="group rounded-2xl border border-[#e1e6e4] bg-white p-5"><div className="flex justify-between"><Icon icon="mdi:map-marker-radius-outline" className="text-2xl text-brand-ink" /><div className="flex gap-1"><button type="button" onClick={() => openAsset("locations", item)} className="grid h-8 w-8 place-items-center rounded-lg text-[#66716d] "><Icon icon="mdi:pencil-outline" /></button><button type="button" onClick={() => void removeAsset("locations", text(item.id), text(item.name))} className="grid h-8 w-8 place-items-center rounded-lg text-[#8a9390] "><Icon icon="mdi:trash-can-outline" /></button></div></div><h3 className="mt-2 text-sm font-semibold text-ink">{text(item.name)}</h3><p className="mt-2 text-xs leading-6 text-[#65706c]">{text(item.description)}</p><div className="mt-3 rounded-xl bg-[#f4f7f5] p-3 text-[11px] leading-5 text-[#69746f]">{text(item.rules) || "暂无额外场景规则"}</div></article>)}</div></section>}

    {editor && <div className="fixed inset-0 z-[60] grid place-items-center bg-[#101615]/55 p-3 backdrop-blur-sm"><section className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-[#f7f9f8] shadow-2xl"><header className="flex items-center justify-between border-b border-[#e1e6e4] bg-white px-5 py-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-ink">Bible editor</p><h3 className="mt-1 text-lg font-semibold">{editor.id ? "编辑" : "新建"}{editor.kind === "characters" ? "人物" : "地点"}</h3></div><button type="button" onClick={() => setEditor(null)} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d9dfdd]"><Icon icon="mdi:close" /></button></header><div className="grid gap-4 p-5 sm:grid-cols-2">{Object.entries(editor.values).map(([key, value]) => <div key={key} className={(["description", "appearance", "personality", "publicProfile", "coreBelief", "coreMotivation", "innerLack", "voiceStyle", "rules"].includes(key) ? "sm:col-span-2" : "")}><AssetField label={({ name: "名称", role: "定位", gender: "性别", age: "年龄", description: "简介", appearance: "外貌", personality: "性格", publicProfile: "公开形象", coreBelief: "核心信念", coreMotivation: "核心动机", innerLack: "内在缺口", voiceStyle: "语言声线", rules: "场景规则" } as Record<string, string>)[key] ?? key} value={value} onChange={(next) => setEditor((current) => current ? { ...current, values: { ...current.values, [key]: next } } : current)} multiline={["description", "appearance", "personality", "publicProfile", "coreBelief", "coreMotivation", "innerLack", "voiceStyle", "rules"].includes(key)} /></div>)}</div><footer className="flex justify-end gap-2 border-t border-[#e1e6e4] bg-white px-5 py-4"><button type="button" onClick={() => setEditor(null)} className="h-10 rounded-xl border border-[#d9dfdd] px-4 text-xs font-semibold">取消</button><button type="button" onClick={() => void saveAsset()} disabled={busy} className="h-10 rounded-xl bg-brand px-5 text-xs font-semibold text-white disabled:opacity-50">保存</button></footer></section></div>}

    {relationOpen && <div className="fixed inset-0 z-[60] grid place-items-center bg-[#101615]/55 p-3 backdrop-blur-sm"><section className="w-full max-w-lg rounded-3xl bg-[#f7f9f8] shadow-2xl"><header className="flex items-center justify-between border-b border-[#e1e6e4] bg-white px-5 py-4"><h3 className="font-semibold">新建人物关系</h3><button type="button" onClick={() => setRelationOpen(false)}><Icon icon="mdi:close" /></button></header><div className="grid gap-4 p-5 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold">起点人物<select value={relation.fromCharacterId} onChange={(event) => setRelation((current) => ({ ...current, fromCharacterId: event.currentTarget.value }))} className="h-10 rounded-xl border border-[#d9dfdd] px-3 text-sm font-normal"><option value="">请选择</option>{characters.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select></label><label className="grid gap-1 text-xs font-semibold">终点人物<select value={relation.toCharacterId} onChange={(event) => setRelation((current) => ({ ...current, toCharacterId: event.currentTarget.value }))} className="h-10 rounded-xl border border-[#d9dfdd] px-3 text-sm font-normal"><option value="">请选择</option>{characters.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select></label><AssetField label="关系类型" value={relation.relationType} onChange={(value) => setRelation((current) => ({ ...current, relationType: value }))} /><AssetField label="关系强度 0-1" value={relation.strength} onChange={(value) => setRelation((current) => ({ ...current, strength: value }))} /><div className="sm:col-span-2"><AssetField label="关系说明" value={relation.description} onChange={(value) => setRelation((current) => ({ ...current, description: value }))} multiline /></div></div><footer className="flex justify-end gap-2 border-t border-[#e1e6e4] bg-white px-5 py-4"><button type="button" onClick={() => setRelationOpen(false)} className="h-10 rounded-xl border border-[#d9dfdd] px-4 text-xs font-semibold">取消</button><button type="button" onClick={() => void saveRelation()} disabled={busy} className="h-10 rounded-xl bg-brand px-5 text-xs font-semibold text-white">保存关系</button></footer></section></div>}
  </section>;
}
